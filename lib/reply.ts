/**
 * What `assistant-ask` answers with, and what a turn has seen: everything the final answer may
 * cite, so a model that names a picture or a node it was never shown is not believed.
 */

import type { AssistantFailure, MediaHit, SearchFilters } from './api.ts';
export type {
  AssistantCard,
  AssistantEvent,
  AssistantFailure,
  AssistantLink,
  AssistantProposal,
  AssistantReply,
  AssistantStep,
  AssistantTable,
  AssistantTiming,
  CommandResult,
  MediaHit,
  ProposalOutcome,
} from './api.ts';

/** The apologies, as the drawer and the next turn's history read them. */
export const FAILURE_ANSWERS: Record<AssistantFailure, string> = {
  unavailable: 'The assistant is not available right now.',
  'no-answer': 'The assistant could not answer this question.',
  'too-long': 'The answer was too long to finish. Ask for less, such as the last 20 rows.',
};

/** Everything a turn's commands have shown, which is everything the final answer may cite. */
export type Seen = {
  /** The pictures of the last `search` the loop ran, less those already shown: the answer's pictures when it names none. */
  hits: MediaHit[];
  /** That search's filters, which the reply's "Show in search" opens. */
  lastSearch: SearchFilters | null;
  /** Every node a result named, by path, with the name it gave: what the answer may link to. */
  named: Map<string, string>;
  /** Pictures earlier answers in this conversation showed: a search leaves them out, so "fler" is new ones. */
  shown: Set<string>;
};

export const emptySeen = (): Seen => ({ hits: [], lastSearch: null, named: new Map(), shown: new Set() });

/** At most this many pictures in one answer; a bigger set belongs on the search page. */
export const MAX_MEDIA = 24;
