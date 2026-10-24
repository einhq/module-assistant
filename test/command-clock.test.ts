import { assert, assertEquals } from '@std/assert';
import { AFTER_SLOW_SECONDS, COMMAND_SECONDS, CommandClock } from '@assistant/command-clock';

Deno.test('a line has a minute until one runs out of it, then seconds, and after a second none run', () => {
  const clock = new CommandClock();
  assertEquals(clock.limitMs, COMMAND_SECONDS * 1000);
  assertEquals(clock.limitMs, COMMAND_SECONDS * 1000, 'lines that finish do not shorten it');
  assert(clock.timedOut().includes(`next lines have ${AFTER_SLOW_SECONDS} s`));
  assertEquals(clock.limitMs, AFTER_SLOW_SECONDS * 1000);
  assert(clock.timedOut().includes('no more commands run this turn'));
  assertEquals(clock.limitMs, undefined);
  assert(clock.refused.startsWith('not run'));
});
