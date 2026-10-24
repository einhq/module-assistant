import { assert, assertEquals } from '@std/assert';
import { EARLIER_RESULT_CHARS, historyStart, makeRoom, SHORTENED, shortened, tokensOf } from '../lib/context.ts';
import type { LlmMessage } from '../lib/llm.ts';

const call = (id: string): LlmMessage => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'stat', arguments: '{}' } }] });
const result = (id: string, chars: number): LlmMessage => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(chars) });
/** A question, one call and its result of `chars` characters. */
const turnOf = (n: number, chars: number): LlmMessage[] => [{ role: 'user', content: `fråga ${n}` }, call(`c${n}`), result(`c${n}`, chars)];

Deno.test('a long result goes back as its start; anything else as it was', () => {
  const long = result('a', EARLIER_RESULT_CHARS * 3);
  assertEquals(shortened(long), { ...long, content: `${'x'.repeat(EARLIER_RESULT_CHARS)}${SHORTENED}` });
  const short = result('b', EARLIER_RESULT_CHARS);
  assert(shortened(short) === short);
  const said: LlmMessage = { role: 'user', content: 'y'.repeat(EARLIER_RESULT_CHARS * 3) };
  assert(shortened(said) === said);
});

Deno.test('the history is cut in one go, and the cut stays put until it is long again', () => {
  const turns = Array.from({ length: 12 }, (_, n) => turnOf(n, 1000));
  const size = JSON.stringify(turns[0][0]).length + JSON.stringify(turns[0][1]).length + JSON.stringify(turns[0][2]).length;
  const limit = size * 4.5;
  // Four turns fit; the fifth passes the limit and the oldest go, down to half of it.
  assertEquals([1, 2, 3, 4].map((n) => historyStart(turns.slice(0, n), limit)), [0, 0, 0, 0]);
  const cut = historyStart(turns.slice(0, 5), limit);
  assertEquals(cut, 3);
  // The turns after it keep that start, so each sends what the last one did and more.
  assertEquals(historyStart(turns.slice(0, 6), limit), cut);
  assertEquals(historyStart(turns.slice(0, 7), limit), cut);
  // Until the history passes the limit again.
  assert(historyStart(turns.slice(0, 8), limit) > cut);
});

Deno.test("room is made from the oldest earlier turns first, then from this turn's older results", () => {
  const earlier = [...turnOf(1, 1000), ...turnOf(2, 1000)];
  const turn = [...turnOf(3, 2000), call('d'), result('d', 2000)];
  const one = tokensOf(turnOf(1, 1000));

  // Room for one earlier turn: the oldest goes, and the history starts with a question.
  assert(makeRoom(earlier, turn, one) >= one);
  assertEquals(earlier, turnOf(2, 1000));
  assertEquals(turn.length, 5);

  // More than the history holds: it all goes, then this turn's results but the last are shortened.
  const freed = makeRoom(earlier, turn, one * 3);
  assertEquals(earlier, []);
  assert((turn[2] as { content: string }).content.endsWith(SHORTENED));
  assertEquals((turn[4] as { content: string }).content.length, 2000, 'the last result is what the model reads now');
  assert(freed < one * 3, 'what was asked for could not all be freed, and it says so');
});
