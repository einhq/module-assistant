/**
 * The assistant's reply, and what the drawer makes of it.
 *
 * `assistant-ask` answers with text plus the things it found: pictures to show, people and
 * locations to link, the search it ran. This file is the pure half of that — the reply as the drawer
 * holds it, the routes its parts map to — so it can be tested without a router or the shell client.
 */

import { ENTITY_KINDS, lightboxRoute, mediaItemFrom, type MediaRef, paramsFromFilters, type SearchFilters } from '@ein/ui/lib';
import { type MediaItem, openRoute } from '@ein/ui/signals';
import type {
  AssistantDraft,
  AssistantEvent as WireAssistantEvent,
  AssistantLink,
  AssistantLive,
  AssistantProposal,
  AssistantReply as WireAssistantReply,
  AssistantStep,
  CommandResult,
  LlmStatus,
} from '@assistant/api';
export type {
  AssistantCard,
  AssistantFailure,
  AssistantLink,
  AssistantLive,
  AssistantProposal,
  AssistantStep,
  AssistantTable,
  AssistantTiming,
  CommandResult,
  LlmStatus,
} from '@assistant/api';

/**
 * One thing the turn did, in order: a thought, words beside a call, a command — as the assistant
 * sends it (`@assistant/api`), plus the drawer's own marker on the command running now or the call
 * the model is still writing.
 */
export type AssistantEvent =
  | Exclude<WireAssistantEvent, { kind: 'command' }>
  | (Extract<WireAssistantEvent, { kind: 'command' }> & { live?: 'running' | 'forming' });

type ThoughtEvent = Extract<AssistantEvent, { kind: 'thinking' }>;
export type CommandEvent = Extract<AssistantEvent, { kind: 'command' }>;

/** A run of commands, with the thoughts that led to each, folded into one dot of the timeline. */
export type WorkEntry = { kind: 'work'; key: number; items: (ThoughtEvent | CommandEvent)[] };
type TimelineEntry = WorkEntry | ((ThoughtEvent | Extract<AssistantEvent, { kind: 'text' | 'waited' }>) & { key: number });

/**
 * A turn's events as its timeline draws them. Commands in a row fold into one entry, with the
 * thoughts before each of them; words the model said end the run. A thought after the last
 * command — the one that leads to the answer — stays a dot of its own.
 */
export const groupEvents = (events: AssistantEvent[]): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];
  let pending: (ThoughtEvent & { key: number })[] = [];
  let open: WorkEntry | undefined;
  events.forEach((event, key) => {
    if (event.kind === 'thinking') {
      pending.push({ ...event, key });
      return;
    }
    if (event.kind === 'command') {
      if (!open) entries.push(open = { kind: 'work', key: pending[0]?.key ?? key, items: [] });
      open.items.push(...pending.map(({ key: _key, ...thought }) => thought), event);
      pending = [];
      return;
    }
    entries.push(...pending, { ...event, key });
    pending = [];
    open = undefined;
  });
  entries.push(...pending);
  return entries;
};

/** The folded run's line: how many commands, how many failed, their time — or that they are still running. */
export const workLine = (entry: WorkEntry): string => {
  const all = entry.items.filter((item): item is CommandEvent => item.kind === 'command');
  const running = all.some((command) => command.live);
  const commands = all.filter((command) => !command.live);
  const failed = commands.filter((command) => command.failed).length;
  const ms = commands.reduce((sum, command) => sum + (command.ms ?? 0), 0);
  const count = `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`;
  if (running) return `Running commands… ${commands.length} done`;
  return `Ran ${count}${failed ? `, ${failed} failed` : ''} · ${(ms / 1000).toFixed(1)}s`;
};

/** What a command printed, laid out to read: JSON indented, text as it came. */
export const readableOutput = (output: string): string => {
  try {
    return JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    return output;
  }
};

type ProposalStatus = 'ran' | 'failed' | 'dismissed';

/** How a proposal ended, as the log records it on the proposing message. */
export type ProposalSettled = { status: ProposalStatus; at: string; error?: string; results?: CommandResult[]; script?: string };

/**
 * The card's code block, which is the script that runs — as one script, through the shell,
 * comments and all. `set -e` leads so a failing line stops the rest, and it is in the block
 * rather than prepended at run time because what the user sees is what runs; they may take
 * it out.
 */
export const proposalScript = (proposal: AssistantProposal): string => ['set -e', ...proposal.commands.map((entry) => `# ${entry.label}\n${entry.command}`)].join('\n\n');

/** The command's filters are a subset of the search page's, so they pass straight through. */
export type AssistantSearch = Pick<SearchFilters, 'query' | 'kinds' | 'subjects' | 'subjectNames' | 'region' | 'fromYear' | 'toYear' | 'like' | 'sort'>;

/**
 * A reply as the drawer holds it: the assistant's (`@assistant/api`) with its media resolved to
 * lightbox items, its search narrowed to the filters the search page takes, and its timeline
 * carrying the drawer's live markers.
 */
export type AssistantReply = Omit<WireAssistantReply, 'media' | 'search' | 'timeline'> & {
  media: MediaRef[];
  search: AssistantSearch | null;
  timeline?: AssistantEvent[];
};

/**
 * Where a node goes: a file to the lightbox, anything else to the route its type opens by
 * (`ui.open`, as the search cards follow it), or nowhere when no installed module opens its type.
 */
export const routeForNode = (type: string, path: string): string | undefined => {
  const clean = path.replace(/\/+$/, '');
  return type === 'file' ? lightboxRoute(clean) : openRoute(type, clean) ?? undefined;
};

/** Where a link under the answer goes. */
export const routeForLink = (link: AssistantLink): string | undefined => routeForNode(link.type, link.path);

/**
 * The assistant's filters in the page that can show what they find: the search page lists only
 * albums, people, locations, devices and tracks, so a search for anything else — pictures, most of
 * all, or no kind at all — opens Media, which takes the same parameters.
 */
export const routeForSearch = (search: AssistantSearch): string => {
  const entities = !!search.kinds?.length && search.kinds.every((kind) => ENTITY_KINDS.includes(kind));
  return `${entities ? '/search' : '/media'}?${paramsFromFilters(search).toString()}`;
};

/** The cited pictures as lightbox-ready items. */
export const replyMediaItems = (reply: Pick<AssistantReply, 'media'>): MediaItem[] => reply.media.map((ref) => mediaItemFrom(ref));

/** A turn's timeline; one stored without it (or answered by the fast path) is its commands. */
export const eventsOf = (message: { timeline?: AssistantEvent[]; steps?: AssistantStep[] }): AssistantEvent[] =>
  message.timeline ?? (message.steps ?? []).map((step) => ({ kind: 'command' as const, ...step }));

/** How long a thought took, for its collapsed line. */
export const thoughtLine = (ms?: number): string => ms === undefined ? 'Thought' : `Thought for ${(ms / 1000).toFixed(1)}s`;

/** A wait for the model service, which was away, as the timeline says it. */
export const waitedLine = (ms: number): string => `Waited ${Math.round(ms / 1000)}s for the language model to restart`;

/** What the live turn says while it waits: for the model to come back, or for it to answer. */
export const waitingLine = (phase: AssistantLive['phase']): string =>
  phase === 'away' ? 'The language model is restarting; waiting for it…' : phase === 'thinking' ? 'Thinking…' : 'Waiting…';

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };

/**
 * A string field of JSON that is still being written, read as far as it goes: the answer inside a
 * `final_answer` call whose arguments are streaming. Undefined until the field has begun.
 */
export const partialJsonString = (json: string, field: string): string | undefined => {
  const start = new RegExp(`"${field}"\\s*:\\s*"`).exec(json);
  if (!start) return undefined;
  let out = '';
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const c = json[i];
    if (c === '"') break;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = json[i + 1];
    // An escape cut off by the stream is the next delta's.
    if (next === undefined) break;
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ESCAPES[next] ?? next;
    i++;
  }
  return out;
};

/**
 * What the bubble shows of a draft: the answer's words as they come — in `final_answer`, or said
 * outright — or the call the model is making, which is about to become a command.
 */
export const draftView = (draft: AssistantDraft): { reasoning: string; text: string; call?: string } => {
  const reasoning = draft.reasoning.trim();
  if (draft.tool === 'final_answer') return { reasoning, text: partialJsonString(draft.args ?? '', 'answer') ?? '' };
  return { reasoning, text: draft.content.trim(), ...(draft.tool ? { call: `${draft.tool} ${draft.args ?? ''}`.trim() } : {}) };
};

/** The turn's total time; the timeline above it already shows what ran. */
export const timingLine = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(1)}s`;

/**
 * What the chat input says about the model (`llm-status`), with its icon: where questions go when a
 * provider answers them; nothing for ours. Said plainly, for someone who wonders where their
 * question goes, not for an operator.
 */
export const llmNotice = (status: LlmStatus | null): { icon: string; text: string } | null => {
  if (status?.kind === 'external') {
    return {
      icon: 'world-upload',
      text: `Answered by ${status.provider}: your questions, and the names, places and search results used to answer them, leave this server.`,
    };
  }
  return null;
};
