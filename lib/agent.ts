/**
 * One turn of the assistant on EiN's own commands: the model calls a command, the code runs
 * it and hands back what it printed, until the model answers with `final_answer`.
 *
 * THE COMMANDS ARE THE TOOLS. The modules name the commands they offer (`drop-ins.ts`), and each
 * is offered as the model's native tool, described by its own `--help` spec (`toolSchema`), so a
 * command is offered the moment it describes itself, with nothing to keep in step. The prompt is
 * the file an operator can edit (`COMMANDS_PROMPT_PATH`), then what each module says of its part.
 *
 * THE CONVERSATION IS THE MODEL'S. Every earlier turn goes back to the model as it happened — each
 * call and each answer, and each result, a long one shortened — from the transcript stored with the
 * chat's assistant messages, and the turn's own messages come back in `transcript` for the caller to
 * store. The model service (`llm.ts`, the OpenAI chat API) keeps its cache of what it last read and
 * reads only where a new request differs from it; so the history must be sent the same way every
 * time, which is why the time is stamped into each user message from the chat log rather than put in
 * the system text. What the model reads at once is limited, and `context.ts` keeps the conversation
 * inside it: the oldest turns go, and a turn that outgrows it has its older results shortened.
 *
 * THE REPLY IS THE DRAWER'S. What the model says becomes an `AssistantReply`: pictures only if a
 * command this turn listed them, links only to nodes a result named, cards
 * only as the modules offer them (`cards.ts`), and a write command never run — it becomes a
 * proposal card for the user.
 *
 * Nothing here fails the command. A model that will not call a tool, a command that errors, an EMS
 * that is down: each ends the turn with something the drawer can show, and `error` for a log.
 */

import type { CmdSpec, Command } from '@ein/client';
import { commandsIn, isVisitor, judgeLine, shq, toolCallToCommandLine, toolSchema } from '@ein/client';
import { chat, contextTokens, LlmContextError, type LlmDraft, type LlmMessage, type LlmTool, LlmUnavailableError } from './llm.ts';
import { historyStart, makeRoom, shortened, tokensOf } from './context.ts';
import { COMMANDS_PROMPT_PATH, commandsSystem, stampedMessage } from './prompt-native.ts';
import type { AssistantContext, AssistantProgressPhase } from './api.ts';
import {
  type AssistantCard,
  type AssistantEvent,
  type AssistantFailure,
  type AssistantLink,
  type AssistantReply,
  type AssistantStep,
  type AssistantTable,
  type AssistantTiming,
  emptySeen,
  FAILURE_ANSWERS,
  MAX_MEDIA,
  type MediaHit,
  type Seen,
} from './reply.ts';
import { hitFrom, type SearchFilters } from './search.ts';
import { fastAnswer } from '@assistant/fast';
import { keepKnownLinks } from '@assistant/answer-links';
import { cardFrom, type CardOffer, cardProperty, loadCards } from '@assistant/cards';
import { modulePrompts, offeredTools } from './drop-ins.ts';
import { findCommands, indexedSpec, unavailable } from '@assistant/command-index';
import { listLines, tableFrom, withoutRows } from '@assistant/table';
import { CommandClock } from '@assistant/command-clock';

/** Commands per turn before the model is told to answer. A chain of lookups takes five. */
export const DEFAULT_MAX_STEPS = 12;
/**
 * Tokens one model call may write. A call is ~50; a final answer is what needs room: 2048 fits a
 * table of about a hundred short rows. More does not help, since the 4B model cannot copy a longer
 * series without moving values between rows; a log is charted by path, and tabled by the line
 * that prints it, instead.
 */
const MAX_NEW_TOKENS = 2048;
/** Tokens per call when the user asked for thinking. */
const THINKING_TOKENS = 4096;
/** A thinking model writes its thought inside the same budget, so it may be given more (`CFG_LLM_MAX_TOKENS`). */
const maxNewTokens = (cmd: Command): number => {
  const configured = parseInt(String(cmd.env.CFG_LLM_MAX_TOKENS ?? ''), 10);
  return Number.isFinite(configured) && configured > 0 ? configured : MAX_NEW_TOKENS;
};
/** A call waiting longer is stuck behind the crawl or a cold model; not a chat any more. */
const TIMEOUT_SECONDS = 180;
/** How much of a command's output the model is handed. A search page is ~5 KB. */
const RESULT_CHARS = 4000;
/**
 * How much of a command's text output — `cat` of a log or a file — the model is handed. More than a
 * JSON result, since a question about a series needs every row: ten years of weekly weights is ~12 KB.
 */
const TEXT_CHARS = 16_000;
/**
 * Lines of text output, or items of a JSON list, from which the model is told, under the result,
 * how to show it as a table. Handed a log's rows, Qwen3.5-4B reshapes them with awk and sed until
 * the turn runs out, whatever the prompt says; the call to make, written where it reads the rows, is
 * what it follows. A reply that lists this many rows anyway gets the table of the line it was told
 * about.
 */
const TABLE_HINT_LINES = 20;
/** Malformed replies, repeated calls in a row, or requests too long for the model, before the turn gives up. */
const RETRIES = 2;

/** The line above a proposal card. The code's, not the model's. */
const PROPOSAL_QUESTION = 'Shall I run this?';
const NOT_A_CALL = 'Reply by calling a command, or final_answer. Do not write prose.';
const BUDGET = 'That is as many commands as one question gets. Answer now with final_answer, from what the results above say.';
const REPEATED = 'already called with exactly these arguments; the result is above. Use it, or call something else';
/** What the model hears for a change the guest asked for: nothing changes without signing in. */
const GUEST_WRITES = 'the user has not signed in and may change nothing here; it was not shown to them. Answer without it, and say a change needs signing in';
/** Said once the turn's slow lines are spent: a refused line in a tool result alone does not stop the model calling more. */
const SLOW_SPENT = 'No more commands run for this question: they took too long. Answer now with final_answer, from what the results above say, and say what took too long.';
/**
 * Said as the user after a repeated call, as BUDGET is: whatever a tool result says, Qwen3.5-4B
 * calls the same command again, and the same words as a user message stop it.
 */
const ANSWER_FROM_ABOVE = 'You have that result above already. Answer now with final_answer, from what the results above say.';
/** Said after a thought that filled the call's token limit, for a call made without thinking. */
const THOUGHT_SPENT = 'Your thinking used up the room for this step. Answer now with final_answer, from what the results above say.';
const STILL_REPEATING = 'the model kept repeating the same command';

export type AgentOptions = {
  message: string;
  /** When the message was sent: the chat log's time for it, so a rebuild stamps it the same. */
  sentAt: Date;
  /** Earlier turns as the model saw them (`transcriptFromChat`). */
  earlier: LlmMessage[];
  context: AssistantContext;
  maxSteps?: number;
  /** Ask as this person rather than the account's own (`agent-eval --user`). */
  user?: { name: string; path: string } | null;
  /** A prompt file other than the installed one, to measure a change before making it. */
  promptPath?: string;
  /** Skip the one-search fast path (`agent-eval` measures the loop). */
  noFast?: boolean;
  /**
   * Think before every call (the drawer's "think harder"): fewer malformed command lines at twice
   * the wait, so it is the user's choice per question. It skips the fast path, which has no model to
   * think with.
   */
  think?: boolean;
  onModelPhase?: (phase: AssistantProgressPhase) => void | Promise<void>;
  /** Stream each model call, hearing its draft as it grows, and null once it has answered. */
  onDraft?: (draft: LlmDraft | null) => void;
  /** The timeline each time it grows, and the command line about to run. */
  onTimeline?: (timeline: AssistantEvent[], running?: string) => void;
  /**
   * Go on with the last turn rather than answer a new message: the user has just run or declined its
   * proposal, and `earlier` ends with that outcome, what the change printed included. `message` is
   * then the question the turn began with, and is not sent again.
   */
  resume?: boolean;
};

/** A step with what `agent-eval` needs besides the drawer's trail. */
type AgentStep = AssistantStep & { line?: string; code?: number; bytes?: number; verdict?: 'ran' | 'failed' | 'proposed' | 'repeated' | 'unknown' };

type AgentReply = Omit<AssistantReply, 'steps'> & {
  steps: AgentStep[];
  /** This turn's messages as the model saw them, the user's included: store it with the reply. */
  transcript: LlmMessage[];
  /**
   * What the model read before the conversation, and its checksum: the caller stores it with the
   * chat when the checksum differs from the one it has (`ModelContext` in chat-store.ts).
   */
  modelContext?: { checksum: string; system: string; tools: unknown[] };
  /** Per model call, the prompt tokens the service read and the ones it reused from its cache. */
  cache?: string[];
  /** Tokens the model wrote this turn, thought included, and how many calls the token limit cut short. */
  tokens?: { generated: number; truncated: number };
};

// --- the tools ------------------------------------------------------------------------------

type Surface = { specs: Map<string, CmdSpec>; tools: LlmTool[]; cards: CardOffer[] };

const FINAL_ANSWER = {
  name: 'final_answer',
  description: "Reply to the user. Call this when no more commands are needed, in the language of the user's message.",
  parameters: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: "The reply, in the language of the user's message. Do not list the pictures in it; the app shows them." },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Media to show, by path, when not the pictures of the last search: leave it out to show those.',
      },
      links: {
        type: 'array',
        items: { type: 'string' },
        description: 'What a result named that the reply is about — a person, a place, a folder — by path (optional).',
      },
      table: {
        type: 'object',
        description: 'A table under the reply, of the rows a command prints: a log, a listing. The app runs the line and shows every row, ' +
          'so never copy rows into the reply. Only for more than a few rows; a short table you write yourself.',
        properties: {
          command: {
            type: 'string',
            description: 'The line that prints the rows, as for run_command: cat -t /path/to/log for every entry, cat -t /path/to/log | tail -n 10 for the last ten.',
          },
          title: { type: 'string', description: "A short title, in the language of the user's message." },
          columns: { type: 'array', items: { type: 'string' }, description: 'The fields to show, in order (optional: all of them).' },
        },
        required: ['command'],
      },
    },
    required: ['answer'],
  },
};

/**
 * The rest of EiN, found when needed. The shell has about three hundred commands — services,
 * pipelines, jobs, users, modules, storage as well as what the modules keep — and offering each as a tool
 * would cost every call its schema and give a small model too much to choose between. So the
 * model finds one by what it should do (`find_commands`, `command-index.ts`), reads its spec
 * (`command_help`) and runs a line (`run_command`). What the line does decides what happens to it:
 * a read runs at once, a write becomes a proposal card the user runs or declines (`judgeLine`).
 */
export const FIND_COMMANDS = {
  name: 'find_commands',
  description: 'Find EiN shell commands by what they should do, for anything the other tools do not cover: services, pipelines, jobs, users, groups, ' +
    'modules, settings, storage, files, and whatever else the modules installed here keep. Answers with the best commands, what each does, and whether it changes anything.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the command should do, in a few English words: "list running services", "restart a failed pipeline".' },
    },
    required: ['query'],
  },
};

export const COMMAND_HELP = {
  name: 'command_help',
  description: "One command's arguments, flags, an example and what it returns. Read it before run_command with a command you have not used.",
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'The command, as find_commands named it.' } },
    required: ['name'],
  },
};

export const RUN_COMMAND = {
  name: 'run_command',
  description: 'Run a bash line in the EiN shell: one command, a pipe, or a few lines. A line that only reads runs now and you get what it printed. ' +
    'A line that changes anything — creating, writing, moving or removing files, setting, starting or stopping things — is shown to the user, who runs it or not; ' +
    'you then hear how it went. Never tell the user to run something themselves: run it with this.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The line, for the EiN shell, with absolute paths: e.g. service-list, or echo "Hej" > /home/<user>/hej.txt. No $$.',
      },
      why: { type: 'string', description: "What it does, in a few words in the language of the user's message: the title the user sees on a change." },
    },
    required: ['command'],
  },
};

/** `final_answer` with a property for each card the modules offer. */
const finalAnswer = (cards: CardOffer[]) => ({
  ...FINAL_ANSWER,
  parameters: {
    ...FINAL_ANSWER.parameters,
    properties: { ...FINAL_ANSWER.parameters.properties, ...Object.fromEntries(cards.map((card) => [card.name, cardProperty(card)])) },
  },
});

/** How long the commands' specs are kept before they are asked again. */
const SURFACE_TTL_MS = 10 * 60 * 1000;
let specsCache: { at: number; names: string; specs: Map<string, CmdSpec> } | undefined;

/**
 * The tools: the commands the modules offer, each described by its spec, asked of it with `--help`
 * in JSON — and kept — and `final_answer` with the cards the modules offer. Which commands and
 * cards are read each time, as they are cheap.
 *
 * Asking them all costs seconds of a turn's setup, for specs that change only when a command does.
 * So the surface is kept in this module for the process (a bin's modules stay imported between
 * runs) and asked again after SURFACE_TTL_MS, which bounds how long a `mod setup` that changes a
 * command waits to be seen. Keeping it also keeps the tools byte-identical from turn to turn, which
 * the model service's cache needs to go on from where it was.
 *
 * Asked twice: the first `--help` after a deploy can race the module loader. Only a complete
 * surface is kept, so a command that did not answer is asked again next turn rather than left out
 * for ten minutes.
 */
export const loadSurface = async (cmd: Command): Promise<Surface> => {
  const names = await offeredTools(cmd);
  const key = names.join('\n');
  let specs = specsCache && specsCache.names === key && Date.now() - specsCache.at < SURFACE_TTL_MS ? specsCache.specs : undefined;
  if (!specs) {
    specs = new Map<string, CmdSpec>();
    for (const name of names) {
      for (let attempt = 0; attempt < 2 && !specs.has(name); attempt++) {
        const help = await cmd.execute(`JSON_OUTPUT=1 ${name} --help`);
        try {
          specs.set(name, JSON.parse(`${help.stdout}`.trim()) as CmdSpec);
        } catch { /* asked again, then left out */ }
      }
    }
    if (specs.size === names.length) specsCache = { at: Date.now(), names: key, specs };
  }
  const cards = await loadCards(cmd);
  const tools: LlmTool[] = [...[...specs.values()].map(toolSchema), FIND_COMMANDS, COMMAND_HELP, RUN_COMMAND, finalAnswer(cards)].map((schema) => ({
    type: 'function',
    function: schema,
  }));
  return { specs, tools, cards };
};

// --- parsing a reply --------------------------------------------------------------------------

const TOOL_CALL_TAG = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/;
// Closing tags are optional: a reply cut by the token budget is still the call it started to be.
const TOOL_CALL_XML = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/;
const TOOL_CALL_PARAM = /<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;

type Call = { name: string; args: Record<string, unknown> };

/** The call in a reply, in whichever shape the template writes it; undefined for prose. */
const parseCall = (text: string): Call | undefined => {
  const tagged = TOOL_CALL_TAG.exec(text);
  if (tagged) {
    try {
      const call = JSON.parse(tagged[1]) as { name?: string; arguments?: Record<string, unknown>; args?: Record<string, unknown> };
      if (call.name) return { name: call.name, args: (call.arguments ?? call.args ?? {}) as Record<string, unknown> };
    } catch { /* the other shapes */ }
  }
  const xml = TOOL_CALL_XML.exec(text);
  if (xml) {
    const args: Record<string, unknown> = {};
    for (const [, key, value] of xml[2].matchAll(TOOL_CALL_PARAM)) {
      const trimmed = value.trim();
      try {
        args[key] = JSON.parse(trimmed);
      } catch {
        args[key] = trimmed;
      }
    }
    return { name: xml[1], args };
  }
  // `name(arg="…")`, which a model shown signatures rather than trained on a tag falls into.
  const bare = /(?:^|\n)\s*([a-z][\w-]*)\(([\s\S]*)\)\s*$/.exec(text.trim());
  if (bare) {
    const args: Record<string, unknown> = {};
    for (const [, key, quoted, plain] of bare[2].matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,)\s]+))/g)) {
      args[key] = quoted !== undefined ? quoted.replace(/\\"/g, '"') : plain;
    }
    return { name: bare[1], args };
  }
  return undefined;
};

// --- what the results showed --------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const nameOf = (item: Record<string, unknown>, path: string): string =>
  typeof item.name === 'string' && item.name ? item.name : typeof item.title === 'string' && item.title ? item.title : path.split('/').pop() ?? path;

const slugOf = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

/** A picture, a video or a sound, by what a result says of it: its kind, or its mimetype, its own or in its attributes. */
const isMedia = (item: Record<string, unknown>): boolean => {
  const mimetype = typeof item.mimetype === 'string' ? item.mimetype : asRecord(item.attrs)?.mimetype;
  return ['photo', 'video', 'audio'].includes(String(item.kind)) || (typeof mimetype === 'string' && /^(image|video|audio)\//.test(mimetype));
};

/** Everything a result named, remembered so the answer may cite it and nothing else. */
const noteResult = (value: unknown, seen: Seen, media: Map<string, MediaHit>, depth = 0): void => {
  if (depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) noteResult(item, seen, media, depth + 1);
    return;
  }
  const item = asRecord(value);
  if (!item) return;
  const path = typeof item.path === 'string' ? item.path.replace(/\/+$/, '') : undefined;
  if (path?.startsWith('/')) {
    const name = nameOf(item, path);
    // A path without a name (a search's own `filters.subjects`) never replaces a name already heard.
    if (name !== slugOf(path) || !seen.named.has(path)) seen.named.set(path, name);
    if (isMedia(item)) {
      const hit = hitFrom(item);
      if (hit) media.set(path, hit);
    }
  }
  for (const child of Object.values(item)) {
    if (child && typeof child === 'object') noteResult(child, seen, media, depth + 1);
  }
};

const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) {
    // A model sometimes passes a list as its JSON text.
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* one value */ }
    return value.split(/[\n,]/).map((part) => part.trim()).filter(Boolean);
  }
  return [];
};

const yearOf = (value: unknown): number | undefined => {
  const year = parseInt(String(value ?? ''), 10);
  return Number.isInteger(year) && year > 1800 && year < 3000 ? year : undefined;
};

/** A `search` call in the search page's own filter words, so the drawer can open the same search. */
const filtersOf = (args: Record<string, unknown>): SearchFilters => {
  const kinds = list(args.kind).filter((kind) => ['photo', 'video', 'audio', 'document', 'album'].includes(kind)) as SearchFilters['kinds'];
  const bbox = typeof args.bbox === 'string' ? args.bbox.split(',').map(Number) : [];
  return {
    ...(typeof args.query === 'string' && args.query ? { query: args.query } : {}),
    ...(kinds && kinds.length ? { kinds } : {}),
    ...(list(args.subject).length ? { subjects: list(args.subject) } : {}),
    ...(list(args['subject-name']).length ? { subjectNames: list(args['subject-name']) } : {}),
    ...(bbox.length === 4 && bbox.every(Number.isFinite) ? { region: { shape: 'bbox' as const, north: bbox[0], south: bbox[1], east: bbox[2], west: bbox[3] } } : {}),
    ...(yearOf(args.from ?? args.after) ? { fromYear: yearOf(args.from ?? args.after) } : {}),
    ...(yearOf(args.to ?? args.before) ? { toYear: yearOf(args.to ?? args.before) } : {}),
    ...(typeof args.like === 'string' && args.like ? { like: args.like } : {}),
    ...(['score', 'time', '-time', 'name'].includes(String(args.sort)) ? { sort: args.sort as SearchFilters['sort'] } : {}),
  };
};

// --- the conversation ---------------------------------------------------------------------------

type StoredMessage = { role: string; content: string; timestamp?: string; transcript?: unknown; outcome?: unknown; [key: string]: unknown };

const isLlmMessage = (value: unknown): value is LlmMessage => {
  const message = asRecord(value);
  return !!message && ['user', 'assistant', 'tool'].includes(String(message.role));
};

/**
 * What a script the user ran printed, for the note that says it ran: a model told only "Done"
 * proposes the script again when asked about its output.
 */
const printed = (outcome: unknown): string => {
  const results = asRecord(outcome)?.results;
  if (!Array.isArray(results)) return '';
  const text = results.map((entry) => String(asRecord(entry)?.output ?? '').trim()).filter(Boolean).join('\n');
  return text ? `\nIt printed:\n${text.slice(0, TEXT_CHARS)}` : '';
};

/**
 * The chat log as the model saw it. A user message is stamped with its own time; an assistant
 * message replays the transcript it was stored with — each call and answer, and each result, a long
 * one shortened — or, for one without (the fast path's), its text. A proposal's outcome is a note
 * from the app. The oldest turns go once the history is long (`historyStart`).
 */
export const transcriptFromChat = (messages: StoredMessage[]): LlmMessage[] => {
  // A turn is a question and what answered it, a proposal's outcome included.
  const turns: LlmMessage[][] = [];
  for (const message of messages) {
    if ((message.role === 'user' && !message.outcome) || !turns.length) turns.push([]);
    const out = turns[turns.length - 1];
    const at = message.timestamp ? new Date(message.timestamp) : undefined;
    if (message.outcome) {
      const note = `(the app: ${message.content}${printed(message.outcome)})`;
      out.push({ role: 'user', content: at ? stampedMessage(note, at) : note });
    } else if (message.role === 'user') {
      // The stamp the turn itself used is stored with it; a message without one is stamped from its time.
      const stamped = typeof message.stamped === 'string' ? message.stamped : at ? stampedMessage(message.content, at) : message.content;
      out.push({ role: 'user', content: stamped });
    } else if (Array.isArray(message.transcript) && message.transcript.every(isLlmMessage)) {
      // The transcript starts with the user's message, which is already out above.
      out.push(...message.transcript.filter((entry, i) => !(i === 0 && entry.role === 'user')).map(shortened));
    } else if (message.role === 'assistant') {
      out.push({ role: 'assistant', content: message.content });
    }
  }
  return turns.slice(historyStart(turns)).flat();
};

// --- the turn -------------------------------------------------------------------------------------

/**
 * A reading line as it runs: in JSON mode when it is one command, or when jq reads what it prints,
 * so the model gets each command's typed answer. A line that pipes or substitutes into text tools
 * — `ls … | wc -l`, `$(find …)` — runs in text mode, a name per line: in JSON mode each command
 * prints its answer as one line, every count comes out as 1, and the model recounts until the turn
 * runs out. Text mode is set, not left to the caller, since the web interface runs in JSON mode.
 */
const scriptFor = async (line: string): Promise<string> => {
  const names = await commandsIn(line);
  return `export JSON_OUTPUT=${names.length <= 1 || names.includes('jq') ? 1 : 0}\n${line}`;
};

const runJson = async (cmd: Command, line: string): Promise<Record<string, unknown> | undefined> => {
  const result = await cmd.execute(`JSON_OUTPUT=1 ${line}`);
  if (result.code !== 0) return undefined;
  try {
    return asRecord(JSON.parse(`${result.stdout}`));
  } catch {
    return undefined;
  }
};

/** Who is asking, when the account is linked to a person: that person's node and name. */
const whoami = async (cmd: Command, seen: Seen): Promise<{ name: string; path: string } | undefined> => {
  const me = await runJson(cmd, 'user-whoami');
  const path = typeof me?.personPath === 'string' ? me.personPath : undefined;
  if (!path) return undefined;
  let name: string | undefined;
  try {
    const attr = (await cmd.sys.vfs.get(cmd.access, path)).attrs.name;
    name = typeof attr === 'string' && attr.trim() ? attr.trim() : undefined;
  } catch { /* named by the account, or by the node */ }
  name ??= typeof me?.name === 'string' && me.name ? me.name : slugOf(path);
  seen.named.set(path, name);
  return { name, path };
};

/** A checksum of what the model reads before the conversation, to tell when it has changed. */
const checksumOf = async (system: string, tools: unknown[]): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify({ system, tools }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
};

type IdCall = { id: string; name: string; args: Record<string, unknown> };

/** The model's call as the API wants it back in the history — with its own words, if it wrote any. */
const callMessage = (content: string, call: IdCall): LlmMessage => ({
  role: 'assistant',
  content,
  tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }],
});
/** Whether the asker can see a node: what a link in the answer is allowed to open. */
const nodeExists = async (cmd: Command, path: string): Promise<boolean> => (await nodeType(cmd, path)) !== undefined;

/** A node's type, as the asker sees it; nothing when they cannot. */
const nodeType = async (cmd: Command, path: string): Promise<string | undefined> => {
  try {
    return (await cmd.sys.vfs.get(cmd.access, path)).type;
  } catch {
    return undefined;
  }
};

/** A result, answering the call by id. Every call gets one — `final_answer` too: the API requires it. */
const result = (id: string, content: unknown): LlmMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: typeof content === 'string' ? cut(content) : resultJson(content),
});

/**
 * A JSON result as the model is handed it, cut at `RESULT_CHARS`. Past the limit an object's fields
 * go smallest first, so what the cut takes is the end of its longest list, not the fields after it:
 * `search --facets` prints its long `days` before `years`, and a model never shown the years makes up
 * a count for each.
 */
export const resultJson = (content: unknown): string => {
  const json = JSON.stringify(content) ?? '';
  if (json.length <= RESULT_CHARS || !content || typeof content !== 'object' || Array.isArray(content)) return json.slice(0, RESULT_CHARS);
  const fields = Object.entries(content).map(([key, value], order) => ({ key, value, order, size: (JSON.stringify(value) ?? '').length }));
  fields.sort((a, b) => a.size - b.size || a.order - b.order);
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field.key, field.value]))).slice(0, RESULT_CHARS);
};

/** A command's text output, cut where it would crowd out the conversation, saying that it was. */
const cut = (text: string): string => text.length <= TEXT_CHARS ? text : `${text.slice(0, TEXT_CHARS)}\n… (${text.length - TEXT_CHARS} more characters not shown)`;

/**
 * The part of every chat's system message that is the same for all: the prompt file, then what each
 * module says of its part. Nothing without the file.
 */
export const readPrompt = async (cmd: Command, path: string): Promise<string | undefined> => {
  const file = await cmd.execute(`cat ${shq(path)}`);
  const text = `${file.stdout ?? ''}`.trim();
  return file.code === 0 && text ? [text, ...await modulePrompts(cmd)].join('\n\n') : undefined;
};

/**
 * Why `cat` may not run on this path, or undefined when it may. `cat` is a read command for most
 * types, not all: with no path it copies stdin, which a turn has none of; on a queue it takes the
 * messages it prints, and on a router it waits for the next one for as long as the turn lasts.
 */
const catRefusal = async (cmd: Command, path: unknown): Promise<string | undefined> => {
  if (typeof path !== 'string' || !path.startsWith('/')) return 'cat takes the absolute path of the node to print';
  let type: string;
  try {
    type = (await cmd.sys.vfs.get(cmd.access, path)).type;
  } catch {
    return undefined; // cat says what is wrong with the path itself
  }
  if (type === 'queue') return 'not read: cat on a queue takes its messages away. stat shows its settings';
  if (type === 'router') return 'not read: cat on a router waits for new messages. stat shows its settings';
  return undefined;
};

/** A line the model wrote may be at most this long: a change is a line or a few, not a program. */
const COMMAND_CHARS = 2000;

/** What `command_help` shows of a spec: what a call needs. */
const helpView = ({ json: _json, group: _group, daemon: _daemon, ...spec }: CmdSpec) => spec;

/**
 * Why a line may not run from the chat at all, confirmed or not; nothing when it may. A command the
 * shell does not have is refused with similar ones it does, rather than proposed to fail on the card
 * after the user pressed Run.
 */
const refusal = async (cmd: Command, line: string): Promise<string | undefined> => {
  const ampersand = ampersandInPath(line);
  if (ampersand) return ampersand;
  for (const name of await commandsIn(line)) {
    const spec = await indexedSpec(cmd, name);
    // `type` knows the shell's builtins (echo, printf, test …) that no PATH directory lists.
    if (!spec && !/[$`]/.test(name) && (await cmd.execute(`type ${shq(name)}`)).code !== 0) {
      const similar = (await findCommands(cmd, name.replace(/-/g, ' '), 5)).map((hit) => hit.name);
      return `${name} is not an EiN command${similar.length ? `; there is ${similar.join(', ')}` : ''}. find_commands finds one by what it should do`;
    }
    if (spec && unavailable(spec)) {
      return `${name} cannot be run from the chat: ${spec.daemon ? 'it is a service, started with service-start' : 'it needs a terminal or is the assistant itself'}`;
    }
  }
  return undefined;
};

/** What ends an unquoted word in a line, `&` among them. */
const WORD_END = /[\s;|&()<>]/;

/**
 * Why a line breaks on a path with `&` in it, or nothing when none does. Unquoted, the shell takes
 * the `&` of `/archive/albums/Anna_&_Bo` as running what is before it in the background, and runs
 * the rest of the path as a command of its own, whose error says nothing of the quoting. The model
 * is handed the whole line quoted: told only how, Qwen3.5-4B sends the same line again.
 */
export const ampersandInPath = (line: string): string | undefined => {
  let quote: string | undefined;
  let word = '';
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') word += line[++i] ?? '';
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '\\') word += line[++i] ?? '';
    else if (char !== '&' || !word) word = WORD_END.test(char) ? '' : word + char;
    else {
      const path = word.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '');
      const rest = line.slice(i + 1).match(/^[^\s;|()<>]*/)![0];
      if (path.startsWith('/') && rest && !rest.startsWith('&')) {
        const whole = `${path}&${rest}`;
        const glob = whole.search(/[*?[]/);
        const cut = glob < 0 ? whole.length : whole.lastIndexOf('/', glob);
        const quoted = `'${whole.slice(0, cut)}'${whole.slice(cut)}`;
        return `not run: the path ${whole} has & in it, which the shell reads as an operator. Put the path in single quotes, any glob outside them, and run this line instead:\n${
          line.split(whole).join(quoted)
        }`;
      }
      word = '';
    }
  }
  return undefined;
};

/** A change's title when the model gave none: its first line. */
const firstCommandOf = (line: string): string => {
  const first = line.split('\n').map((part) => part.trim()).find((part) => part && !part.startsWith('#')) ?? line;
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
};

/** The step of a table's line that the turn had not run: its rows came from running it then. */
export const TABLE_STEP = 'table';

/** A line as compared with one run before: the same words, whatever the quoting and spacing. */
const sameLine = (line: string): string => line.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();

/** The paths a line names, for the card: a node a result named by that name. */
const targetsOf = (line: string, seen: Seen): { name: string; path: string }[] => {
  const paths = [...new Set([...line.matchAll(/(?:^|[\s'"=])(\/[^\s'"]+)/g)].map((match) => match[1].replace(/\/+$/, '')))];
  return paths.slice(0, 5).map((path) => ({ name: seen.named.get(path) ?? slugOf(path), path }));
};

export const ask = async (cmd: Command, options: AgentOptions, surface?: Surface): Promise<AgentReply> => {
  const startedAt = Date.now();
  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const seen = emptySeen();
  for (const path of options.context.shown ?? []) seen.shown.add(path);
  const steps: AgentStep[] = [];
  const timeline: AssistantEvent[] = [];
  const note = (event: AssistantEvent) => {
    timeline.push(event);
    options.onTimeline?.(timeline);
  };
  /** A step for the trail, and for the timeline with what the command printed, which its card shows. */
  const record = (step: AgentStep, output?: string) => {
    steps.push(step);
    // A proposal is its card, which follows the timeline; the step would say it twice.
    if (step.verdict === 'proposed') return;
    const { tool, args, summary, ms, verdict, line, code } = step;
    note({
      kind: 'command',
      tool,
      args,
      summary,
      ...(ms !== undefined ? { ms } : {}),
      ...(verdict === 'failed' || verdict === 'unknown' ? { failed: true } : {}),
      ...(line ? { line } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(output ? { output: output.slice(0, RESULT_CHARS) } : {}),
    });
  };
  const timing: AssistantTiming = { model: 0, modelCalls: 0, tools: 0, setup: 0 };
  const stamped = stampedMessage(options.message, options.sentAt, options.context);
  const turn: LlmMessage[] = options.resume ? [] : [{ role: 'user', content: stamped }];
  const cacheModes: string[] = [];
  const tokens = { generated: 0, truncated: 0 };
  let model: string | undefined;
  // Set once the prompt is read, but `reply` reads it on the failures before that, which a const would not survive.
  // deno-lint-ignore prefer-const
  let modelContext: AgentReply['modelContext'];

  const reply = (fields: Partial<AssistantReply> & { answer: string }): AgentReply => ({
    media: [],
    links: [],
    search: seen.lastSearch,
    ...fields,
    steps,
    timeline,
    ...(model ? { model } : {}),
    elapsedMs: Date.now() - startedAt,
    timing,
    transcript: turn,
    ...(modelContext ? { modelContext } : {}),
    ...(cacheModes.length ? { cache: cacheModes } : {}),
    ...(tokens.generated || tokens.truncated ? { tokens } : {}),
  });
  const failed = (reason: string, failure: AssistantFailure = 'no-answer') => reply({ answer: FAILURE_ANSWERS[failure], error: reason, failure });

  const user = options.user === undefined ? await whoami(cmd, seen) : options.user ?? undefined;
  if (options.user) seen.named.set(options.user.path, options.user.name);

  /**
   * A link to a node the asker can see, with the type the chat opens it by. A label that is only
   * the path's last part gives way to the node's own name, when it has one.
   */
  const linkTo = async (path: string, label: string): Promise<AssistantLink | undefined> => {
    try {
      const node = await cmd.sys.vfs.get(cmd.access, path);
      const name = typeof node.attrs.name === 'string' ? node.attrs.name.trim() : '';
      return { label: label === slugOf(path) && name ? name : label, path, type: node.type };
    } catch {
      return undefined;
    }
  };

  // A thought shares the per-call limit with the call it leads to, and may run to tens of thousands of characters.
  const tokenLimit = options.think ? Math.max(maxNewTokens(cmd), THINKING_TOKENS) : maxNewTokens(cmd);

  if (!options.noFast && !options.think && !options.resume) {
    // A plain request for pictures: one short parse and one search, no loop.
    const fast = await fastAnswer(cmd, options.message, seen, startedAt, linkTo);
    if (fast) {
      turn.push({ role: 'assistant', content: fast.answer });
      return { ...fast, steps: fast.steps, transcript: turn };
    }
  }

  const prompt = await readPrompt(cmd, options.promptPath ?? COMMANDS_PROMPT_PATH);
  if (!prompt) return failed(`no prompt at ${options.promptPath ?? COMMANDS_PROMPT_PATH}`, 'unavailable');
  const { specs, tools, cards } = surface ?? await loadSurface(cmd);
  const home = typeof cmd.env.HOME === 'string' && cmd.env.HOME !== '/' ? cmd.env.HOME.replace(/\/$/, '') : undefined;
  const system: LlmMessage = { role: 'system', content: commandsSystem(prompt, { user, home, language: cmd.env.CFG_LANGUAGE }) };
  modelContext = { checksum: await checksumOf(system.content, tools), system: system.content, tools };
  timing.setup = Date.now() - startedAt;

  const media = new Map<string, MediaHit>();
  const made = new Set<string>();
  /** What each line that ran this turn printed, by `sameLine`: a table of it needs no second run. */
  const printedBy = new Map<string, string>();
  let malformed = 0;
  let repeats = 0;
  let budgetSpent = false;
  /** The earlier turns this turn sends, fewer once it has had to make room. */
  const earlier = [...options.earlier];
  /** How many tokens the model reads at once, when its service says. */
  let contextSize = await contextTokens(cmd);
  /** The prompt as the service counted it at the last call, and how much of `turn` it held. */
  let counted: { tokens: number; through: number } | undefined;
  let tooLong = 0;
  /** How long the next line may run: a search answers in seconds, a `find` over the archive does not. */
  const clock = new CommandClock();
  let tableRefused = false;
  /** The last line whose result came with the table hint. */
  let hinted: string | undefined;
  /** A thought has filled a call's token limit this turn; `thinkingOff` while the call after it is to come. */
  let thoughtFilled = false;
  let thinkingOff = false;
  /** The turn's call that may only answer has been asked; `answerOnly` while it is to come. */
  let answerAsked = false;
  let answerOnly = false;
  const answerTools = tools.filter((tool) => (tool.function as { name?: string }).name === FINAL_ANSWER.name);
  /**
   * A model stuck repeating a call is offered only final_answer, once a turn and without thinking:
   * told to answer, it calls the command again while it can, though its results would answer.
   * False when that call has been asked already.
   */
  const lastWord = (): boolean => {
    if (answerAsked) return false;
    answerAsked = answerOnly = true;
    return true;
  };

  /**
   * The table `final_answer` asked for: the rows its line printed — this turn, or now, when it only
   * reads — or why there is none.
   */
  const tableOf = async (raw: unknown): Promise<AssistantTable | string> => {
    const asked = asRecord(raw) ?? (typeof raw === 'string' ? { command: raw } : {});
    const line = String(asked.command ?? asked.line ?? '').replace(/\r\n?/g, '\n').trim().slice(0, COMMAND_CHARS);
    if (!line) return 'table.command is empty: give the line whose output is the table';
    let output = printedBy.get(sameLine(line));
    if (output === undefined) {
      const refused = await refusal(cmd, line);
      if (refused) return refused;
      if ((await judgeLine(line, (name) => specs.get(name) ?? indexedSpec(cmd, name))).effect === 'write') {
        return `${line} changes something; a table shows a line that only reads`;
      }
      const limitMs = clock.limitMs;
      if (limitMs === undefined) return clock.refused;
      options.onTimeline?.(timeline, line);
      const ranAt = Date.now();
      const ran = await cmd.execute(await scriptFor(line), { timeoutMs: limitMs });
      output = `${ran.stdout ?? ''}`.trim();
      const error = ran.timedOut ? clock.timedOut() : `${ran.stderr || output}`.trim();
      timing.tools += Date.now() - ranAt;
      record({
        tool: TABLE_STEP,
        args: asked,
        summary: ran.code === 0 ? line : `${line} — failed`,
        line,
        code: ran.code,
        bytes: output.length,
        verdict: ran.code === 0 ? 'ran' : 'failed',
        ms: Date.now() - ranAt,
      }, ran.code === 0 ? output : error);
      if (ran.code !== 0) return `${line} failed: ${error.slice(0, 400)}`;
    }
    const title = typeof asked.title === 'string' ? asked.title.trim().slice(0, 80) : '';
    return tableFrom(output, line, { ...(title ? { title } : {}), columns: list(asked.columns) }) ?? `${line} printed nothing to show as a table`;
  };

  for (;;) {
    // The last count, what the turn added since, and the answer's room must fit what the model reads.
    if (contextSize && counted) {
      const need = counted.tokens + tokensOf(turn.slice(counted.through)) + tokenLimit;
      if (need > contextSize) {
        // Room for this call and a few more, so the next ones read on from it in the service's cache.
        const excess = need - contextSize + contextSize / 8;
        if (makeRoom(earlier, turn, excess) < need - contextSize) return failed(`the conversation does not fit the model's ${contextSize} tokens`);
        counted = undefined;
      }
    }
    let text: string;
    let parsed: IdCall | undefined;
    let structured = false;
    let cut = false;
    const askedAt = Date.now();
    let away = 0;
    const only: boolean = answerOnly;
    const thinking: boolean = options.think === true && !thinkingOff && !only;
    thinkingOff = answerOnly = false;
    try {
      // The model service has no queue of its own to wait in: the request is the thinking.
      await options.onModelPhase?.('thinking');
      const answer = await chat(cmd, [system, ...earlier, ...turn], {
        tools: only ? answerTools : tools,
        maxTokens: tokenLimit,
        ...(options.think ? { thinking } : {}),
        timeoutSeconds: TIMEOUT_SECONDS,
        ...(options.onDraft ? { onDraft: options.onDraft } : {}),
        // Someone waits for the answer anyway: better late than an apology while the model restarts.
        wait: true,
        onAway: (waiting) => void options.onModelPhase?.(waiting ? 'away' : 'thinking'),
      });
      // Stopped short of its token limit, the answer ran out of context: as if refused for length.
      if (answer.cut && answer.prompt !== undefined && answer.generated !== undefined && answer.generated < tokenLimit) {
        const size = answer.prompt + answer.generated;
        throw new LlmContextError(`the answer filled the model's ${size} tokens after ${answer.generated}`, answer.prompt, size);
      }
      if (answer.prompt !== undefined) counted = { tokens: answer.prompt, through: turn.length };
      text = answer.content;
      model = answer.model;
      cut = answer.cut === true;
      away = answer.awayMs ?? 0;
      if (away) {
        note({ kind: 'waited', ms: away });
        timing.away = (timing.away ?? 0) + away;
      }
      // Noted before the draft is cleared, so a watcher never sees the thought vanish between the two.
      if (answer.reasoning) note({ kind: 'thinking', text: answer.reasoning, ms: Date.now() - askedAt - away });
      if (answer.read !== undefined) cacheModes.push(`read ${answer.read}, reused ${answer.reused ?? 0}`);
      tokens.generated += answer.generated ?? 0;
      if (answer.cut) tokens.truncated++;
      // One call at a time: a second one in the same answer would need a result the loop never gives.
      const first = answer.calls[0];
      if (first) {
        parsed = first;
        structured = true;
      } else {
        // A model that wrote its call as text rather than through the API's tool_calls.
        const written = parseCall(text);
        if (written) parsed = { id: `call_${turn.length}`, name: written.name, args: written.args };
      }
    } catch (error) {
      if (error instanceof LlmContextError) {
        // Too long for the model: make room by the service's own count, all it can without one, and ask again.
        contextSize = error.limit ?? contextSize;
        const excess = error.tokens && error.limit ? error.tokens + tokenLimit - error.limit + error.limit / 8 : Infinity;
        counted = undefined;
        // Asked again as it was: without thinking, or with only final_answer, if so.
        thinkingOff = options.think === true && !thinking;
        answerOnly = only;
        if (++tooLong <= RETRIES && makeRoom(earlier, turn, excess) > 0) continue;
        return failed(`the conversation does not fit the model: ${error.message}`);
      }
      return failed(
        error instanceof LlmUnavailableError ? `model service unreachable: ${error.message}` : error instanceof Error ? error.message : String(error),
        'unavailable',
      );
    } finally {
      timing.model += Date.now() - askedAt - away;
      timing.modelCalls++;
      options.onDraft?.(null);
    }

    if (!parsed) {
      // A thought that ran to the token limit, going round its plan, leaves no room for the call it
      // leads to. Asked once more without thinking, the model answers from the results it has.
      if (cut && thinking && !text.trim() && !thoughtFilled) {
        thoughtFilled = thinkingOff = true;
        turn.push({ role: 'user', content: THOUGHT_SPENT });
        continue;
      }
      // Prose. Told once to use a tool; after that, or where only final_answer was offered, prose is
      // taken as the answer it plainly is.
      turn.push({ role: 'assistant', content: text });
      if (only || ++malformed > 1 || !text.trim()) {
        if (!text.trim()) return failed(only ? STILL_REPEATING : 'the model gave no answer');
        const { text: answer, types: nodeTypes } = await keepKnownLinks(text.trim(), (path) => nodeType(cmd, path));
        return reply({ answer, ...(Object.keys(nodeTypes).length ? { nodeTypes } : {}) });
      }
      // Not noted: the answer said outright, which the model then gives again through final_answer.
      turn.push({ role: 'user', content: NOT_A_CALL });
      continue;
    }
    // Offered only final_answer, a model that calls anything else is still stuck.
    if (only && parsed.name !== FINAL_ANSWER.name) return failed(STILL_REPEATING);
    // Its own words beside a structured call stay, as the service rendered them; a call written as
    // text is the text, and goes back as a structured call alone.
    turn.push(callMessage(structured ? text : '', parsed));
    // Words beside a command are the model's working; beside the answer they are the answer again.
    if (structured && text.trim() && parsed.name !== 'final_answer') note({ kind: 'text', text: text.trim() });

    if (parsed.name === 'final_answer') {
      // An answer cut at the token limit has unfinished arguments, which parse to nothing, or to
      // the start of its text. After a result that came with the table hint it is that result
      // copied out, and is given its table; otherwise it is said to be too long, rather than shown
      // as an empty bubble.
      const tooLong = () => {
        turn.push(result(parsed.id, 'shown to the user'));
        return failed(`the answer was longer than ${tokenLimit} tokens`, 'too-long');
      };
      if (cut && !hinted) return tooLong();
      const said = String(parsed.args.answer ?? '').trim().slice(0, 4000);
      // A reply that copies a hinted result's rows instead of naming its line is given that table.
      const copied = hinted && (cut || listLines(said) >= TABLE_HINT_LINES) ? { command: hinted } : undefined;
      const tableArg = (cut ? undefined : parsed.args.table) ?? copied;
      const table = tableArg === undefined ? undefined : await tableOf(tableArg);
      if (cut && typeof table !== 'object') return tooLong();
      // A table that cannot be made is said once, for the model to name another line or answer without.
      if (typeof table === 'string' && !tableRefused) {
        tableRefused = true;
        turn.push(result(parsed.id, { error: `not shown: ${table}` }));
        continue;
      }
      const tabled = typeof table === 'object' ? table : undefined;
      turn.push(result(parsed.id, tabled ? `shown to the user, with the ${tabled.rows.length} rows of ${tabled.line} as a table` : 'shown to the user'));
      const { text: answer, types: nodeTypes } = await keepKnownLinks(tabled ? withoutRows(said) : said, (path) => nodeType(cmd, path));
      // The pictures: those named, if a result listed them; with none named, the last search's —
      // unless the answer carries a card, which a search on the way to it has nothing to add to
      // (a card that shows pictures is given them).
      const named = list(parsed.args.paths);
      const asked = cards.filter((card) => parsed.args[card.name] !== undefined);
      const fills = asked.some((card) => Object.values(card.fill).includes('pictures'));
      const shown = (named.length ? named.map((path) => media.get(path)).filter((hit): hit is MediaHit => !!hit) : asked.length && !fills ? [] : seen.hits)
        .filter((hit) => ['photo', 'video', 'audio'].includes(hit.kind ?? 'photo'))
        .slice(0, MAX_MEDIA);
      // Links to nodes a result named; a picture is in the grid, not a link.
      const links: AssistantLink[] = [];
      for (const raw of [...list(parsed.args.links), ...named]) {
        const path = raw.replace(/\/+$/, '');
        const name = seen.named.get(path);
        if (name === undefined || media.has(path) || links.some((link) => link.path === path)) continue;
        const link = await linkTo(path, name);
        if (link) links.push(link);
      }
      const drawn: AssistantCard[] = [];
      for (const card of asked) {
        const one = await cardFrom(card, parsed.args[card.name], (path) => nodeExists(cmd, path), shown.map((hit) => hit.path));
        if (one) drawn.push(one);
      }
      return reply({
        answer,
        media: shown,
        links,
        ...(drawn.length ? { cards: drawn } : {}),
        ...(tabled ? { table: tabled } : {}),
        ...(Object.keys(nodeTypes).length ? { nodeTypes } : {}),
      });
    }

    if (budgetSpent) return failed('the model kept calling commands past its budget');

    /** Past the budget, the next call is told to answer. */
    const spend = () => {
      if (steps.filter((step) => step.verdict === 'ran' || step.verdict === 'failed').length >= maxSteps) {
        budgetSpent = true;
        turn.push({ role: 'user', content: BUDGET });
      }
    };

    /** A call already made this turn, with the same arguments: its result is above. */
    const repeated = (key: string): boolean => {
      if (!made.has(key)) {
        made.add(key);
        // A new call between repeats: the model is still finding things out, not stuck.
        repeats = 0;
        return false;
      }
      record({ tool: parsed!.name, args: parsed!.args, summary: 'repeated', verdict: 'repeated' });
      turn.push(result(parsed!.id, { error: REPEATED }));
      turn.push({ role: 'user', content: ANSWER_FROM_ABOVE });
      return true;
    };

    /**
     * A line that changes something: never run here. The turn ends as a card the user runs or
     * declines — but not the guest's, who changes nothing: the model hears so and goes on.
     */
    const propose = async (line: string, title: string, targets: { name: string; path: string }[]): Promise<AgentReply | undefined> => {
      if (isVisitor(cmd.access)) {
        record({ tool: parsed!.name, args: parsed!.args, summary: `${line} — refused`, line, verdict: 'failed' });
        turn.push(result(parsed!.id, { error: GUEST_WRITES }));
        return undefined;
      }
      record({ tool: parsed!.name, args: parsed!.args, summary: line, line, verdict: 'proposed', ms: 0 });
      turn.push(result(parsed!.id, { proposed: line, note: 'shown to the user to run or decline; not run yet' }));
      // The nodes it changes that a result named, as links; one it would make is not there yet.
      const links: AssistantLink[] = [];
      for (const target of targets.filter((target) => seen.named.has(target.path))) {
        const link = await linkTo(target.path, target.name);
        if (link) links.push(link);
      }
      return reply({ answer: PROPOSAL_QUESTION, links, proposal: { title, commands: [{ command: line, label: title }], targets } });
    };

    /** Run a line that only reads, and hand the model what it printed. */
    const run = async (line: string, script: string, onResult?: (view: unknown, output: string) => void) => {
      const limitMs = clock.limitMs;
      if (limitMs === undefined) {
        record({ tool: parsed!.name, args: parsed!.args, summary: `${line} — not run`, line, verdict: 'failed' });
        turn.push(result(parsed!.id, { error: clock.refused }));
        turn.push({ role: 'user', content: SLOW_SPENT });
        spend();
        return;
      }
      options.onTimeline?.(timeline, line);
      const ranAt = Date.now();
      const ran = await cmd.execute(script, { timeoutMs: limitMs });
      const output = `${ran.stdout ?? ''}`.trim();
      let view: unknown = output;
      try {
        view = JSON.parse(output);
      } catch { /* a command that answered in text is data too */ }
      if (ran.code === 0) {
        noteResult(view, seen, media);
        printedBy.set(sameLine(line), output);
        onResult?.(view, output);
      } else {
        view = { error: ran.timedOut ? clock.timedOut() : `${ran.stderr || output}`.trim().slice(0, 400) };
      }
      timing.tools += Date.now() - ranAt;
      record({
        tool: parsed!.name,
        args: parsed!.args,
        summary: ran.code === 0 ? line : `${line} — failed`,
        line,
        code: ran.code,
        bytes: output.length,
        verdict: ran.code === 0 ? 'ran' : 'failed',
        ms: Date.now() - ranAt,
      }, ran.code === 0 ? output : `${ran.stderr || output}`.trim());
      const handed = result(parsed!.id, view);
      const lines = typeof view === 'string' ? view.split('\n').length : Array.isArray(view) ? view.length : 0;
      if (ran.code === 0 && lines >= TABLE_HINT_LINES) {
        hinted = line;
        handed.content += `\n(${lines} ${typeof view === 'string' ? 'lines' : 'rows'}. To show them as a table: final_answer with table {"command": ${
          JSON.stringify(line)
        }}; the app draws every row.)`;
      }
      turn.push(handed);
      if (ran.timedOut && clock.limitMs === undefined) turn.push({ role: 'user', content: SLOW_SPENT });
      spend();
    };

    /** A lookup of the commands themselves: shown on the timeline as the shell line that does the same. */
    const lookup = (line: string, view: unknown, ms: number) => {
      record({ tool: parsed!.name, args: parsed!.args, summary: line, line, code: 0, verdict: 'ran', ms }, JSON.stringify(view));
      turn.push(result(parsed!.id, view));
      spend();
    };

    if (parsed.name === FIND_COMMANDS.name) {
      const query = String(parsed.args.query ?? parsed.args.name ?? '').trim().slice(0, 200);
      if (!query) {
        turn.push(result(parsed.id, { error: 'query is empty: say in a few words what the command should do' }));
        if (++malformed > RETRIES) return failed('the model kept asking find_commands for nothing');
        continue;
      }
      if (repeated(`${parsed.name}:${query.toLowerCase()}`)) {
        if (++repeats > RETRIES && !lastWord()) return failed(STILL_REPEATING);
        continue;
      }
      const startedAt = Date.now();
      const hits = (await findCommands(cmd, query)).map(({ score: _score, ...hit }) => hit);
      lookup(`assistant-commands find ${shq(query)}`, hits.length ? { commands: hits } : { none: `no command for ${query}` }, Date.now() - startedAt);
      continue;
    }

    if (parsed.name === COMMAND_HELP.name) {
      const name = String(parsed.args.name ?? parsed.args.command ?? '').trim().split(/\s+/)[0];
      if (!name || repeated(`${parsed.name}:${name}`)) {
        if (!name) turn.push(result(parsed.id, { error: 'name is empty: give the command, as find_commands named it' }));
        if (++malformed > RETRIES) return failed('the model kept asking command_help for nothing');
        continue;
      }
      const startedAt = Date.now();
      const spec = await indexedSpec(cmd, name);
      const view = spec && !unavailable(spec)
        ? helpView(spec)
        : { none: `${name}: no such command`, similar: (await findCommands(cmd, name.replace(/-/g, ' '), 5)).map((hit) => hit.name) };
      lookup(`${name} --help`, view, Date.now() - startedAt);
      continue;
    }

    if (parsed.name === RUN_COMMAND.name) {
      const line = String(parsed.args.command ?? parsed.args.script ?? parsed.args.line ?? '').replace(/\r\n?/g, '\n').trim().slice(0, COMMAND_CHARS);
      const why = String(parsed.args.why ?? parsed.args.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!line) {
        turn.push(result(parsed.id, { error: 'command is empty: give the shell line to run' }));
        if (++malformed > RETRIES) return failed('the model kept running empty commands');
        continue;
      }
      if (repeated(`${parsed.name}:${line}`)) {
        if (++repeats > RETRIES && !lastWord()) return failed(STILL_REPEATING);
        continue;
      }
      const judgement = await judgeLine(line, (name) => indexedSpec(cmd, name));
      const refused = await refusal(cmd, line);
      if (refused) {
        record({ tool: parsed.name, args: parsed.args, summary: `${line} — refused`, line, verdict: 'failed' });
        turn.push(result(parsed.id, { error: refused }));
        if (++malformed > RETRIES) return failed('the model kept running commands the assistant may not');
        continue;
      }
      if (judgement.effect === 'write') {
        const proposed = await propose(line, why || firstCommandOf(line), targetsOf(line, seen));
        if (proposed) return proposed;
        if (++malformed > RETRIES) return failed('the model kept proposing changes the guest may not make');
        continue;
      }
      await run(line, await scriptFor(line));
      continue;
    }

    const spec = specs.get(parsed.name);
    if (!spec) {
      record({ tool: parsed.name, args: parsed.args, summary: `no command ${parsed.name}`, verdict: 'unknown' });
      turn.push(result(parsed.id, { error: `no command named ${parsed.name}: find_commands finds one by what it should do` }));
      if (++malformed > RETRIES) return failed('the model kept calling commands that do not exist');
      continue;
    }

    if (repeated(`${parsed.name}:${JSON.stringify(parsed.args)}`)) {
      if (++repeats > RETRIES && !lastWord()) return failed(STILL_REPEATING);
      continue;
    }

    if (parsed.name === 'cat') {
      const refused = await catRefusal(cmd, parsed.args.path);
      if (refused) {
        record({ tool: parsed.name, args: parsed.args, summary: `cat refused: ${refused}`, verdict: 'failed' });
        turn.push(result(parsed.id, { error: refused }));
        if (++malformed > RETRIES) return failed('the model kept calling cat on what it cannot read');
        continue;
      }
    }

    const line = toolCallToCommandLine(spec, parsed.args);
    // Judged like any line: an offered command that writes — or a reading one given a flag that
    // does — is the user's to run.
    if ((await judgeLine(line, (name) => specs.get(name) ?? indexedSpec(cmd, name))).effect === 'write') {
      const targets = Object.values(parsed.args)
        .filter((value): value is string => typeof value === 'string' && value.startsWith('/'))
        .map((path) => ({ name: seen.named.get(path) ?? slugOf(path), path }));
      const proposed = await propose(line, spec.description ?? parsed.name, targets);
      if (proposed) return proposed;
      if (++malformed > RETRIES) return failed('the model kept proposing changes the guest may not make');
      continue;
    }

    const { name, args } = parsed;
    await run(line, `JSON_OUTPUT=1 ${line}`, (view) => {
      if (name === 'search') {
        // What the drawer shows when the answer names no pictures, and the search page opens with.
        const results = asRecord(view)?.results;
        seen.hits = Array.isArray(results) ? results.map(hitFrom).filter((hit): hit is MediaHit => !!hit && !seen.shown.has(hit.path)) : [];
        seen.lastSearch = filtersOf(args);
      }
    });
  }
};
