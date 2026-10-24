/**
 * Every command on the user's PATH, findable by what it is for.
 *
 * The shell has about three hundred commands, too many to offer a small model as tools. So the
 * model gets `find_commands`, which searches this index — by meaning, a vector of each command's
 * name and description against the query's, from the command the core setting `CFG_TEXT_EMBEDDER`
 * names, and by words, because a query that names the thing ("service", "pipeline") should find the
 * command called that whatever the vector says. With no embedder, or one that does not answer, it
 * searches by words alone.
 *
 * The commands and their specs are core's command catalogue (`commandCatalogue`); what is kept
 * here is a vector per command. Embedding three
 * hundred of them costs seconds, so the vectors are kept: in this module for the life of the
 * process (a bin's modules stay imported between runs), and in the user's home for the next one,
 * each with the text and the model it was made from, so a command is embedded again only when what
 * it says changed or the model did — two models' vectors are not comparable.
 */

import type { TextEmbedding } from '@ein/api';
import type { CatalogueEntry, CmdSpec, Command } from '@ein/client';
import { commandCatalogue, forgetCommandCatalogues, shq } from '@ein/client';
import type { CommandHit } from './api.ts';

type IndexedCommand = CatalogueEntry & {
  /** Absent when the model service could not embed it; the command is then found by words. */
  vector?: number[];
  /** What the vector was made from: a deploy renews every command node, but rarely what they say. */
  text?: string;
  /** The model that made the vector: only a query from the same one is compared with it. */
  model?: string;
};

type Embedded = { text: string; vector: number[]; model: string };

/** Hits `find_commands` gives: enough to choose from, few enough to read. */
export const DEFAULT_HITS = 8;
const CONCURRENCY = 4;
/**
 * Seconds an embedding may wait. The model service answers a search box in two; building the index
 * sends hundreds while the media service may be indexing, and at two most of them time out.
 */
const INDEX_EMBED_SECONDS = 30;
const QUERY_EMBED_SECONDS = 5;
/** Embeddings failing in a row before a refresh stops asking: the service is then taken to be down. */
const EMBED_FAILURES = 3;
const CACHE_FILE = '.cache/assistant-commands.json';

/**
 * Commands the assistant may not run: an editor needs a terminal, a session is the user's, a
 * daemon is started as a service, and the assistant does not ask itself.
 */
const REFUSED = new Set(['edit', 'login', 'logout', 'assistant-ask', 'agent-eval']);
export const unavailable = (spec: CmdSpec): boolean => REFUSED.has(spec.name) || !!spec.daemon;

/**
 * Not found either: what it may not run, the shell's own completion and screen helpers, and group
 * dispatchers — `service` is found as `service-list`, `service-restart` and the rest, each with its
 * own effect.
 */
const hidden = (spec: CmdSpec): boolean => unavailable(spec) || !!spec.group || ['clear', 'completion'].includes(spec.name) || spec.name.startsWith('completion-');

/** Per user, as the catalogue is: the vectors made for the commands on their PATH, by name. */
const vectors = new Map<string, { byName: Map<string, Embedded>; loaded: boolean; building?: Promise<void> }>();

const homeOf = (cmd: Command): string | undefined => {
  const home = typeof cmd.env.HOME === 'string' ? cmd.env.HOME.replace(/\/$/, '') : '';
  return home && home !== '/' ? home : undefined;
};

/** What a command is for, as the vector sees it: its name as words, its description, what it returns. */
const commandText = (spec: CmdSpec): string =>
  [`${spec.name.replace(/-/g, ' ')}: ${spec.description ?? ''}`.trim(), spec.returns ? `Returns ${spec.returns}` : ''].filter(Boolean).join('. ');

/** Why the last embedding failed, for `assistant-commands reindex` to say. */
let embedError: string | undefined;
export const lastEmbedError = (): string | undefined => embedError;

/** The text embedder's answer to a line of arguments, or why there is none. */
const askEmbedder = async (cmd: Command, args: string): Promise<TextEmbedding | string> => {
  const embedder = cmd.env.CFG_TEXT_EMBEDDER?.trim();
  if (!embedder) return 'no text embedder (CFG_TEXT_EMBEDDER)';
  const ran = await cmd.execute(`JSON_OUTPUT=1 ${embedder} ${args}`);
  if (ran.code !== 0) return `${ran.stderr || ran.stdout}`.trim() || `${embedder} failed`;
  try {
    return JSON.parse(`${ran.stdout}`) as TextEmbedding;
  } catch {
    return `${embedder} did not answer JSON`;
  }
};

const embed = async (cmd: Command, text: string, timeoutSeconds: number, role: 'query' | 'document'): Promise<Omit<Embedded, 'text'> | undefined> => {
  const answer = await askEmbedder(cmd, `--role ${role} --timeout ${timeoutSeconds} ${shq(text)}`);
  if (typeof answer === 'string' || !Array.isArray(answer.vectors?.[0])) {
    embedError = typeof answer === 'string' ? answer : 'the text embedder answered no vector';
    return undefined;
  }
  return { vector: answer.vectors[0], model: answer.model };
};

/** How long the embedder's answer to "which model" is trusted: asking costs a round trip. */
const MODEL_TTL_MS = 10 * 60_000;
let currentModel: { model: string | undefined; at: number } | undefined;

/**
 * The model new vectors come from, or undefined when the embedder cannot say (then nothing is
 * re-embedded for being another model's: better stale vectors than none).
 */
const expectedModel = async (cmd: Command): Promise<string | undefined> => {
  if (!currentModel || Date.now() - currentModel.at > MODEL_TTL_MS) {
    const answer = await askEmbedder(cmd, '--model');
    currentModel = { model: typeof answer === 'string' ? undefined : answer.model || undefined, at: Date.now() };
  }
  return currentModel.model;
};

/**
 * The kept vectors, read straight from the VFS: `cat` cuts its output at two megabytes, and a cut
 * file is a JSON error and a re-embedding.
 */
const loadCache = async (cmd: Command): Promise<Map<string, Embedded>> => {
  const home = homeOf(cmd);
  const byName = new Map<string, Embedded>();
  if (!home) return byName;
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, `${home}/${CACHE_FILE}`, { mode: 'r' });
    let text: string;
    try {
      text = await new Response(handle.readable).text();
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(text) as { commands?: { name?: string; text?: string; vector?: number[]; model?: string }[] };
    for (const entry of parsed.commands ?? []) {
      if (typeof entry.name === 'string' && typeof entry.text === 'string' && Array.isArray(entry.vector) && typeof entry.model === 'string') {
        byName.set(entry.name, { text: entry.text, vector: entry.vector, model: entry.model });
      }
    }
  } catch {
    // None kept yet, or unreadable: embedded again.
  }
  return byName;
};

/** Four decimals of a unit vector rank as the full ones do, in a third of the file. */
const rounded = (vector: number[]): number[] => vector.map((value) => Math.round(value * 1e4) / 1e4);

/** Best effort: a user who cannot write their home still has the vectors for this process. */
const saveCache = async (cmd: Command, byName: Map<string, Embedded>): Promise<void> => {
  const home = homeOf(cmd);
  if (!home) return;
  try {
    const [dirName, fileName] = CACHE_FILE.split('/');
    await cmd.sys.vfs.ensure(cmd.access, 'directory', home, dirName);
    await cmd.sys.vfs.ensure(cmd.access, 'file', `${home}/${dirName}`, fileName, { attrs: { mimetype: 'application/json' } });
    const handle = await cmd.sys.vfs.open(cmd.access, `${home}/${CACHE_FILE}`, { mode: 'w' });
    try {
      const commands = [...byName].map(([name, { text, vector, model }]) => ({ name, text, model, vector: rounded(vector) }));
      await handle.write(new TextEncoder().encode(JSON.stringify({ commands })));
    } finally {
      await handle.close();
    }
  } catch {
    // Kept in memory regardless.
  }
};

/**
 * The user's index: core's catalogue, each command with its vector. A command whose text is new or
 * changed is embedded; a few failed embeddings in a row and the model service is taken to be down
 * for this pass — three hundred timeouts would hold the turn for minutes, and the words find
 * commands meanwhile. Concurrent callers share one pass.
 */
export const commandIndex = async (cmd: Command): Promise<Map<string, IndexedCommand>> => {
  const catalogue = await commandCatalogue(cmd);
  const key = String(cmd.access.uid);
  let kept = vectors.get(key);
  if (!kept) vectors.set(key, kept = { byName: new Map(), loaded: false });
  const current = kept;

  const texts = new Map([...catalogue.values()].map((entry) => [entry.name, commandText(entry.spec)]));
  const model = await expectedModel(cmd);
  const stale = () =>
    [...texts].filter(([name, text]) => {
      const embedded = current.byName.get(name);
      return embedded?.text !== text || (model !== undefined && embedded.model !== model);
    });
  if (!current.loaded || stale().length > 0) {
    current.building ??= (async () => {
      if (!current.loaded) {
        for (const [name, embedded] of await loadCache(cmd)) current.byName.set(name, embedded);
        current.loaded = true;
      }
      const missing = stale();
      let failures = 0;
      let changed = false;
      for (let i = 0; i < missing.length && failures < EMBED_FAILURES; i += CONCURRENCY) {
        await Promise.all(
          missing.slice(i, i + CONCURRENCY).map(async ([name, text]) => {
            if (failures >= EMBED_FAILURES) return;
            const embedded = await embed(cmd, text, INDEX_EMBED_SECONDS, 'document');
            failures = embedded ? 0 : failures + 1;
            if (!embedded) return;
            current.byName.set(name, { text, ...embedded });
            changed = true;
          }),
        );
      }
      if (changed) await saveCache(cmd, current.byName);
    })().finally(() => current.building = undefined);
    await current.building;
  }

  const index = new Map<string, IndexedCommand>();
  for (const entry of catalogue.values()) {
    const text = texts.get(entry.name)!;
    const embedded = current.byName.get(entry.name);
    index.set(entry.name, { ...entry, text, ...(embedded && embedded.text === text ? { vector: embedded.vector, model: embedded.model } : {}) });
  }
  return index;
};

/** Forget every index and catalogue: for tests, and for `assistant-commands reindex`. */
export const forgetCommandIndexes = (): void => {
  vectors.clear();
  currentModel = undefined;
  forgetCommandCatalogues();
};

const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'what', 'which', 'how', 'my', 'me', 'all', 'show']);

/** Lower-case words, with a plural `s` dropped so "services" meets "service". */
const words = (text: string): string[] =>
  text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map((word) => word.length > 3 ? word.replace(/s$/, '') : word);

const cosine = (a: number[], b: number[]): number => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** How much of the query the command's name and description say, 0–1: the name counts most. */
const wordScore = (query: string[], spec: CmdSpec): number => {
  if (!query.length) return 0;
  const name = new Set(words(spec.name));
  const described = new Set(words(`${spec.description ?? ''} ${spec.returns ?? ''}`));
  return query.reduce((sum, word) => sum + (name.has(word) ? 1 : described.has(word) ? 0.4 : 0), 0) / query.length;
};

/**
 * The commands that best fit what the query asks for, best first. `query` is a few words of what
 * the model wants done ("list running services"); the vector carries the meaning, the words the
 * names.
 */
export const findCommands = async (cmd: Command, query: string, limit = DEFAULT_HITS): Promise<CommandHit[]> => {
  const index = await commandIndex(cmd);
  const asked = words(query);
  const asking = await embed(cmd, query, QUERY_EMBED_SECONDS, 'query');
  const hits: CommandHit[] = [];
  for (const entry of index.values()) {
    if (hidden(entry.spec)) continue;
    const meaning = asking && entry.vector && entry.model === asking.model ? cosine(asking.vector, entry.vector) : 0;
    const score = meaning + 0.5 * wordScore(asked, entry.spec);
    if (score <= 0) continue;
    hits.push({
      name: entry.name,
      ...(entry.spec.description ? { description: entry.spec.description } : {}),
      ...(entry.spec.effect ? { effect: entry.spec.effect } : {}),
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
};

/** One command's spec from the index, as the judge and `command_help` read it. */
export const indexedSpec = async (cmd: Command, name: string): Promise<CmdSpec | undefined> => (await commandCatalogue(cmd)).get(name)?.spec;
