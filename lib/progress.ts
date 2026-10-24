/**
 * A turn in flight, as the drawer samples it (`assistant-chat progress`) while `assistant-ask` runs.
 *
 * Private to the calling uid and ephemeral: it lives in this process from the turn's start to its
 * end, and what it holds is only what the drawer draws in the meantime — the phase, the timeline
 * so far, the command running now, and what the model has written in the call in flight.
 */

import type { Command } from '@ein/client';
import type { LlmDraft } from './llm.ts';
import type { AssistantEvent } from './reply.ts';
import type { AssistantLive, AssistantProgressPhase } from './api.ts';

export const ASSISTANT_PROGRESS_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const turns = new Map<string, AssistantLive>();
const key = (cmd: Command, id: string) => `${cmd.access.uid}:${id}`;

const change = (cmd: Command, id: string, fields: Partial<AssistantLive>) => {
  const live = turns.get(key(cmd, id));
  if (live) turns.set(key(cmd, id), { ...live, ...fields });
};

export const beginAssistantProgress = (cmd: Command, id: string) => turns.set(key(cmd, id), { phase: 'waiting', timeline: [] });
export const setAssistantProgress = (cmd: Command, id: string, phase: AssistantProgressPhase) => change(cmd, id, { phase });

/** The timeline so far, copied: the agent keeps adding to its own. */
export const setAssistantTimeline = (cmd: Command, id: string, timeline: AssistantEvent[], running?: string) => change(cmd, id, { timeline: [...timeline], running });

/** What the model has written in the call in flight; null once the call has answered. */
export const setAssistantDraft = (cmd: Command, id: string, draft: LlmDraft | null) => {
  const call = draft?.calls[0];
  change(cmd, id, {
    draft: draft ? { reasoning: draft.reasoning, content: draft.content, ...(call ? { tool: call.name, args: call.arguments } : {}) } : undefined,
  });
};

export const readAssistantProgress = (cmd: Command, id: string): AssistantLive | null => turns.get(key(cmd, id)) ?? null;
export const finishAssistantProgress = (cmd: Command, id: string) => turns.delete(key(cmd, id));
