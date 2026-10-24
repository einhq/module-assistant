/**
 * The fast path: a plain request for pictures, answered without the tool loop.
 *
 * "Visa bilder på Gösta Strand från 2024" needs no reasoning. The search's own parse — core's
 * `parse-search`, which asks whichever module reads searches here — turns it into filters, and the
 * answer is a sentence the code can write. So: recognise the shape, parse, search once, and
 * answer, in a fraction of the loop's time.
 *
 * Only the shape is recognised here; the words that make a question a *question* — a count, a
 * time or a "who", "this picture", the user themselves — send it to the loop, which is the only
 * thing that can follow them. And the fast path yields to the loop whenever the parse is not
 * sure: a name it could not resolve (a relation is one), nothing found, or no filter at all. It
 * never answers wrongly fast; it either answers plainly or steps aside.
 */

import type { SearchParse } from '@ein/api';
import type { Command } from '@ein/client';
import { shq } from '@ein/client';
import type { AssistantLink, AssistantReply, AssistantStep, Seen } from './reply.ts';
import { MAX_LIMIT, pageFor, searchCommand, type SearchFilters, searchHits } from './search.ts';

/** Requests that begin like this are requests to see pictures. */
const SHOW = /^(visa|hitta|leta (upp|efter|fram)|ge mig|show|find|get)\b|^(bilder|foton|filmer|pictures|photos|videos)\b/i;

/**
 * Words after which the sentence is a question the loop must answer: a count, a time or location
 * question, the picture on screen, the user. `\b` is ASCII-only, so the boundary is spelled out
 * for "på" and its like.
 */
const NEEDS_THE_LOOP = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${
    [
      'hur många',
      'how many',
      'how often',
      'gånger',
      'times',
      'senast',
      'last',
      'när',
      'when',
      'vem',
      'who',
      'vad',
      'what',
      'varför',
      'why',
      'vilka',
      'which',
      'den här',
      'denna',
      'this',
      'jag',
      'mig',
      'min',
      'mitt',
      'mina',
      'vi',
      'oss',
      'me',
      'my',
      'our',
      'år',
      'years?',
      'old',
      'gammal',
    ].join('|')
  })(?![\\p{L}\\p{N}])`,
  'iu',
);

/** A request to see pictures with no question folded into it. */
export const isFastShape = (message: string): boolean => SHOW.test(message) && !NEEDS_THE_LOOP.test(message);

const isSwedish = (message: string): boolean => /^(visa|hitta|leta|ge mig|bilder|foton|filmer)\b/i.test(message.trim());

/** "visa 6 bilder": the page the user asked for, within what a chat shows; otherwise the full page. */
export const countWords = (text: string): number => {
  const match = text.match(/(?:^|\s)(\d{1,2})\s+(bilder|foton|filmer|pictures|photos|videos|images)\b/i);
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? Math.min(MAX_LIMIT, n) : MAX_LIMIT;
};

/** What the parse hands the search and the answer. */
type Parsed = {
  filters: SearchFilters;
  from?: string;
  to?: string;
  parse: SearchParse;
  step: AssistantStep;
  parseMs: number;
};

/** The search's own parse of the request, when it is sure of it: every name resolved, and something to filter on. */
const parse = async (cmd: Command, trimmed: string): Promise<Parsed | undefined> => {
  const parsedAt = Date.now();
  const ran = await cmd.execute(`JSON_OUTPUT=1 parse-search ${shq(trimmed)}`);
  const parseMs = Date.now() - parsedAt;
  let parsed: SearchParse;
  try {
    parsed = JSON.parse(`${ran.stdout}`);
  } catch {
    return undefined;
  }
  // Sure means: a model read it, every name it heard is somebody, and there is at least one real
  // filter — a sentence that parsed to nothing but text is a question about content, and content
  // questions deserve the loop's second look.
  if (ran.code !== 0 || parsed.source !== 'llm' || parsed.unresolved.length > 0) return undefined;
  if (parsed.subjects.length === 0 && !parsed.region && !parsed.from && !parsed.to) return undefined;
  // "Visa album från 2019" is not a request for pictures; the loop has the commands for that.
  const kinds = parsed.kinds.filter((kind): kind is 'photo' | 'video' | 'audio' => kind === 'photo' || kind === 'video' || kind === 'audio');
  if (parsed.kinds.length > 0 && kinds.length === 0) return undefined;

  const subjects = parsed.subjects.flatMap((subject) => subject.ref ? [`${subject.kind}:${subject.ref}`] : []);
  const subjectNames = parsed.subjects.flatMap((subject) => subject.ref ? [] : [`${subject.kind}:${subject.name}`]);
  const filters: SearchFilters = {
    ...(parsed.text ? { query: parsed.text } : {}),
    kinds: kinds.length ? kinds : ['photo', 'video'],
    ...(subjects.length ? { subjects } : {}),
    ...(subjectNames.length ? { subjectNames } : {}),
    ...(parsed.region ? { region: parsed.region } : {}),
    ...(parsed.from ? { fromYear: Number(parsed.from.slice(0, 4)) } : {}),
    ...(parsed.to ? { toYear: Number(parsed.to.slice(0, 4)) } : {}),
    ...(parsed.text ? {} : { sort: '-time' as const }),
  };
  return {
    filters,
    from: parsed.from,
    to: parsed.to,
    parse: parsed,
    step: { tool: 'parse-search', args: { message: trimmed }, summary: `parse-search → ${parsed.explain || 'nothing'}`, ms: parseMs },
    parseMs,
  };
};

/**
 * Try the fast path. Undefined means "not this way": the loop takes over with no cost but
 * the parse, which the loop would have paid for in its own first call anyway.
 *
 * `linkTo` makes a link of a node the answer names, or nothing when the asker cannot see it.
 */
export const fastAnswer = async (
  cmd: Command,
  message: string,
  seen: Seen,
  startedAt: number,
  linkTo: (path: string, label: string) => Promise<AssistantLink | undefined>,
): Promise<AssistantReply | undefined> => {
  const trimmed = message.trim();
  if (!isFastShape(trimmed)) return undefined;

  const parsed = await parse(cmd, trimmed);
  if (!parsed) return undefined;
  const { filters, from, to, parse: read, parseMs } = parsed;

  const searchedAt = Date.now();
  const limit = countWords(trimmed);
  const { hits, more, subjects } = await searchHits(cmd, searchCommand(filters, pageFor(limit, seen), from, to), seen, limit);
  const searchMs = Date.now() - searchedAt;
  if (hits.length === 0) return undefined;

  // The parse's own account of what it found, in the language the request is written in.
  const sv = isSwedish(trimmed);
  const count = `${hits.length}${more ? '+' : ''}`;
  const what = read.kinds.length ? read.explain : `${sv ? 'träffar' : 'results'}: ${read.explain}`;
  const answer = sv ? `Här är ${count} ${what}.${more ? ' Alla finns på söksidan.' : ''}` : `Here are ${count} ${what}.${more ? ' The search page has all of them.' : ''}`;

  const steps: AssistantStep[] = [
    parsed.step,
    { tool: 'search', args: filters as Record<string, unknown>, summary: `search → ${hits.length}${more ? '+' : ''}`, ms: searchMs },
  ];
  // The subjects the search resolved, in the order it was given them, under the names the parse found.
  const named = read.subjects.filter((subject) => subject.ref);
  const links: AssistantLink[] = [];
  for (const [index, subject] of subjects.entries()) {
    const link = await linkTo(subject.path, named[index]?.matches[0]?.name ?? named[index]?.name ?? subject.path);
    if (link) links.push(link);
  }
  return {
    answer,
    media: hits.filter((hit) => hit.kind === undefined || hit.kind === 'photo' || hit.kind === 'video' || hit.kind === 'audio').slice(0, MAX_LIMIT),
    links,
    search: filters,
    steps,
    model: 'fast-path',
    elapsedMs: Date.now() - startedAt,
    timing: { model: parseMs, modelCalls: 0, tools: searchMs, setup: 0 },
  };
};
