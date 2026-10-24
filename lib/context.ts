/**
 * The conversation, fitted into what the model reads at once.
 *
 * fry's model reads 32k tokens, prompt and answer together. The system text and the tools take ~11k
 * of them, and one turn of a dozen picture lookups ~12k more, so two such turns sent back whole leave
 * the third no room (ein/core#708). An earlier turn therefore goes back with its long results shortened — its calls
 * and its answer as they were — and the oldest turns go once the history passes `HISTORY_CHARS`
 * (`historyStart`). Within a turn, the loop makes room before a call whose prompt and answer would not
 * fit, or that the service refused as too long (`makeRoom`).
 */

import type { LlmMessage } from './llm.ts';

/** An earlier turn's result longer than this goes back as its start; the answer says what came of it. */
export const EARLIER_RESULT_CHARS = 600;
/** What a shortened result ends with, for the model to know it saw only the start. */
export const SHORTENED = '… (shortened; run it again to read all of it)';
/**
 * Earlier turns are sent until they pass this many characters, about 8k tokens; then the oldest go,
 * down to half, in one cut. A quarter of a 32k context, beside the system text and the turn's room.
 */
const HISTORY_CHARS = 20_000;
/**
 * Tokens per character of conversation, rounded up from what the model's tokenizer gave on fry:
 * 0.38 for a turn of picture lookups (JSON with paths and checksums), 0.27 for the system text and
 * the tools.
 */
const TOKENS_PER_CHAR = 0.4;

const charsOf = (messages: LlmMessage[]): number => messages.reduce((n, message) => n + JSON.stringify(message).length, 0);

/** The tokens these messages come to, estimated from their length; more rather than fewer. */
export const tokensOf = (messages: LlmMessage[]): number => Math.ceil(charsOf(messages) * TOKENS_PER_CHAR);

/** A result as an earlier turn sends it back: its start, when it is long. */
export const shortened = (message: LlmMessage): LlmMessage =>
  message.role === 'tool' && message.content.length > EARLIER_RESULT_CHARS
    ? { ...message, content: `${message.content.slice(0, EARLIER_RESULT_CHARS)}${SHORTENED}` }
    : message;

/**
 * The first earlier turn to send, given each turn's messages. The cut is worked out turn by turn
 * from the first, as each new turn met it, so it stays where it is until the history passes the limit
 * again: the turns after a cut extend one session in the service's cache.
 */
export const historyStart = (turns: LlmMessage[][], limit = HISTORY_CHARS): number => {
  const sizes = turns.map(charsOf);
  let start = 0;
  let total = 0;
  for (let end = 0; end < sizes.length; end++) {
    total += sizes[end];
    if (total <= limit) continue;
    while (start < end && total > limit / 2) total -= sizes[start++];
  }
  return start;
};

/**
 * Room for `excess` more tokens, estimated: the oldest earlier turns go first, then this turn's
 * results but the last are shortened as an earlier turn's are. Both lists change in place; what it
 * freed comes back, which is less than asked when nothing more can go.
 */
export const makeRoom = (earlier: LlmMessage[], turn: LlmMessage[], excess: number): number => {
  let freed = 0;
  while (freed < excess && earlier.length) {
    freed += tokensOf([earlier.shift()!]);
    // The history starts with something said, not with a call or a result whose question went.
    while (earlier.length && earlier[0].role !== 'user') freed += tokensOf([earlier.shift()!]);
  }
  const last = turn.findLastIndex((message) => message.role === 'tool');
  for (let i = 0; i < last && freed < excess; i++) {
    const short = shortened(turn[i]);
    if (short === turn[i]) continue;
    freed += tokensOf([turn[i]]) - tokensOf([short]);
    turn[i] = short;
  }
  return freed;
};
