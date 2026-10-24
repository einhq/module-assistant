/**
 * What the assistant's commands answer with under `JSON_OUTPUT=1`, as types (`@assistant/api`):
 * a turn's reply and its steps, the live progress of one in flight, stored chats, and the command
 * catalogue.
 *
 * The UI imports these instead of restating the shapes, and the module's own code builds its
 * answers from them. Imports only other type-only files, so a browser can import it without
 * type-checking the module.
 */

import type { CmdEffect } from '@ein/api';

/**
 * What the app shows as a question is asked (`assistant-ask --context`): the page's address, and
 * when the app knows them the sidebar entry it is under, its title, a line on what it shows and the
 * node it is about; the picture open in the lightbox; and the paths the chat has shown already.
 */
export type AssistantContext = {
  route?: string;
  section?: string;
  title?: string;
  about?: string;
  node?: string;
  lightbox?: string;
  shown?: string[];
};

/**
 * A card under an answer: a route a module offers in its drop-in's `cards.json`, with the query the
 * model's arguments became (`cards.ts`). The route's page fetches what it shows when it is drawn.
 */
export type AssistantCard = { id: string; route: string };

type Region = { shape: 'bbox'; north: number; south: number; east: number; west: number };

/** The search page's filter vocabulary, so the UI can open the same search with its controls filled. */
export type SearchFilters = {
  query?: string;
  kinds?: Kind[];
  /** Each `<kind>:<slug>` (`person:anna`), intersected. */
  subjects?: string[];
  /** Each `<kind>:<name>`, the union of every subject of the kind whose name contains it; groups intersect. */
  subjectNames?: string[];
  region?: Region;
  fromYear?: number;
  toYear?: number;
  /** A picture the media looks like, by path (`search --like`). */
  like?: string;
  sort?: Sort;
};

/** A media hit as the UI's `mediaItemFrom` wants it — enough for a thumbnail and the lightbox. */
export type MediaHit = {
  path: string;
  name: string;
  kind?: string;
  mimetype?: string;
  takenAt?: string;
  takenAtUtc?: string;
  width?: number;
  height?: number;
  angle?: number;
  sar?: number;
  duration?: number;
  /** The hand-written description, when the file has one. */
  description?: string;
};

/**
 * A table under an answer: what a command line printed, read into rows by the code (`table.ts`),
 * so no row passes through the model. A column's name is empty where the output gave it none;
 * `more` counts the rows left out past the first thousand.
 */
export type AssistantTable = { line: string; title?: string; columns: string[]; rows: string[][]; more?: number };

/** A node the answer is about, which the chat opens the way its type opens (`ui.open`). */
export type AssistantLink = { label: string; path: string; type: string };

export type AssistantStep = { tool: string; args: Record<string, unknown>; summary: string; ms?: number };

/**
 * One thing the turn did, in order, for the drawer's timeline: what the model thought (when the
 * server has thinking on), what it said beside a call, and each command run. The answer and its
 * cards come after these; they are the reply's own fields.
 */
export type AssistantEvent =
  | { kind: 'thinking'; text: string; ms?: number }
  | { kind: 'text'; text: string }
  /** The model service was away — restarting, most likely — and the turn waited this long for it. */
  | { kind: 'waited'; ms: number }
  | ({
    kind: 'command';
    failed?: boolean;
    /** The line as run, its exit code, and what it printed (stdout, or stderr when it failed), cut at 4000 characters. */
    line?: string;
    code?: number;
    output?: string;
  } & AssistantStep);

/** One command line the user may run, and what it does in words. */
type ProposedCommand = { command: string; label: string };

/**
 * A change the assistant proposes and never makes. The command lines are the code's, built
 * from validated arguments; the drawer shows them as they are and runs them only on the
 * user's say-so, through the same shell path as any other click in the UI.
 */
export type AssistantProposal = {
  /** What the change is, in a few words: the card's title. */
  title: string;
  /** Run in order; stop at the first failure. */
  commands: ProposedCommand[];
  /** The node(s) the change touches, resolved by the code: name and path, shown on the card. */
  targets: { name: string; path: string }[];
};

/** What one command of a proposal said when the drawer ran it. */
export type CommandResult = { command: string; ok: boolean; exitCode?: number; output: string };

/** How a proposal ended, recorded as its own chat message that names the proposing one. */
export type ProposalOutcome = {
  of: string;
  status: 'ran' | 'failed' | 'dismissed';
  error?: string;
  results?: CommandResult[];
  /** The block as the user ran it, when they changed it before pressing Run. */
  script?: string;
};

/**
 * Where a turn's time went, in ms: the model answering, running commands, and — not in `model` —
 * waiting for a model service that was away.
 */
export type AssistantTiming = { model: number; modelCalls: number; tools: number; setup: number; away?: number };

/**
 * Why a turn ended without an answer. `unavailable`: the model service could not be reached or
 * the assistant is not set up, so any question would have failed. `no-answer`: the model ran but
 * gave up on this question — it repeated itself, called commands that do not exist, ran out of
 * budget — and another wording may well work. `too-long`: the answer did not fit the token limit.
 */
export type AssistantFailure = 'unavailable' | 'no-answer' | 'too-long';

export type AssistantReply = {
  answer: string;
  media: MediaHit[];
  links: AssistantLink[];
  /** The last search the assistant ran, in the search page's own filter vocabulary. */
  search: SearchFilters | null;
  /** Set when the turn ended in a proposed change instead of an answer: the user decides next. */
  proposal?: AssistantProposal;
  /** The cards the answer asked for, in the order they were offered. */
  cards?: AssistantCard[];
  /** The rows of a command the answer named to show as a table. */
  table?: AssistantTable;
  /** The type of each node the answer's text links to, by path, so the chat opens it as its type opens. */
  nodeTypes?: Record<string, string>;
  steps: AssistantStep[];
  /** The turn in order; absent from the fast path's. */
  timeline?: AssistantEvent[];
  /** The model that answered — or `fast-path` when the fast path did, with no loop at all. */
  model?: string;
  elapsedMs: number;
  timing?: AssistantTiming;
  /** Set when the answer is an apology rather than an answer: why, in the code's words. */
  error?: string;
  /** Which apology, set with `error`: see `AssistantFailure`. */
  failure?: AssistantFailure;
  /** The stored message's id, added by `assistant-ask` when the turn went into a chat log: what an outcome names. */
  messageId?: string;
};

/** `away`: the model service does not answer — restarting, most likely — and the turn waits for it. */
export type AssistantProgressPhase = 'waiting' | 'thinking' | 'away';

/** The model's call in flight: its reasoning and words, and the tool it is calling with its arguments so far. */
export type AssistantDraft = { reasoning: string; content: string; tool?: string; args?: string };

export type AssistantLive = {
  phase: AssistantProgressPhase;
  timeline: AssistantEvent[];
  /** The command line running now. */
  running?: string;
  draft?: AssistantDraft;
};

export type StoredChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  [key: string]: unknown;
};

/** `assistant-chat examples`: questions the modules suggest asking, for a chat with nothing in it yet. */
export type SuggestedQuestions = { examples: string[] };

export type ChatSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ChatMessage = StoredChatMessage & {
  id: string;
  timestamp: string;
  /** On a message carrying a proposal: how it ended, from the later outcome message that named it. */
  settled?: { status: ProposalOutcome['status']; at: string; error?: string; results?: CommandResult[]; script?: string };
};

export type CommandHit = { name: string; description?: string; effect?: CmdEffect; score: number };

/** The kinds `search --kind` takes. */
const KINDS = ['photo', 'video', 'audio', 'document', 'album'] as const;

type Kind = typeof KINDS[number];

const SORTS = ['score', 'time', '-time', 'name'] as const;

type Sort = typeof SORTS[number];

/**
 * The assistant's language model as `llm-status` answers it. The host profile says whose it is:
 * ours, run on this host (ein/llm), or a provider's service elsewhere (`CFG_LLM_PROVIDER`), to which
 * every question and what the assistant reads to answer it are sent. Of ours it says where it runs
 * (`CFG_LLM_CARD`).
 */
export type LlmStatus = {
  url: string;
  /** The model asked for (`CFG_LLM_MODEL`). A server of ours answers with the one it loaded, whatever this says. */
  model: string;
  kind: 'ours' | 'external';
  /** The provider's name, for an external one. */
  provider?: string;
  /** Where ours runs: on the card beside the share it leaves, or on the CPU. Absent when the host does not say. */
  card?: 'card' | 'cpu';
};
