/**
 * The commands' specs are asked once and kept: asking all of them on every turn costs seconds. A set
 * with a command missing is not kept, so the missing one is asked again on the next turn. The
 * cards are read every turn, from the modules' drop-ins.
 */

import { assertEquals } from '@std/assert';
import type { Command } from '@ein/client';
import { loadSurface, transcriptFromChat } from '../lib/agent.ts';

/** What the modules offer, as their drop-ins list it. */
const ALL = ['ls', 'stat', 'search', 'person-info'];

/**
 * A command runner whose one module offers ALL as tools and no card, and that answers `--help` with
 * a minimal spec, except for the names in `silent`.
 */
const fakeCmd = (silent: Set<string>) => {
  const asked: string[] = [];
  const cmd = {
    sys: { vfs: { children: () => Promise.resolve([{ name: 'test' }]) } },
    execute: (line: string) => {
      if (line.startsWith('cat ')) {
        const tools = line.includes('/tools');
        return Promise.resolve({ code: tools ? 0 : 1, stdout: tools ? `# what the test module offers\n${ALL.join('\n')}\n` : '', stderr: '' });
      }
      const name = line.replace('JSON_OUTPUT=1 ', '').split(' ')[0];
      asked.push(name);
      const stdout = silent.has(name) ? '' : JSON.stringify({ name, description: `the ${name} command`, args: [], flags: [] });
      return Promise.resolve({ code: silent.has(name) ? 1 : 0, stdout, stderr: '' });
    },
  } as unknown as Command;
  return { cmd, asked };
};

Deno.test('a surface with a command missing is not kept', async () => {
  const first = fakeCmd(new Set(['search']));
  const partial = await loadSurface(first.cmd);
  assertEquals(partial.specs.has('search'), false);
  // Asked twice before it is left out: the first --help after a deploy can race the loader.
  assertEquals(first.asked.filter((name) => name === 'search').length, 2);

  const second = fakeCmd(new Set());
  const whole = await loadSurface(second.cmd);
  assertEquals(whole.specs.size, ALL.length);
  assertEquals(second.asked.length, ALL.length, 'asked again, since nothing was kept');
});

// Runs after the test above, which left a whole surface kept.
Deno.test('a whole surface is kept and the next turn asks nothing', async () => {
  const again = fakeCmd(new Set());
  const surface = await loadSurface(again.cmd);
  assertEquals(again.asked, []);
  assertEquals(
    surface.tools.slice(ALL.length).map((tool) => (tool.function as { name: string }).name),
    ['find_commands', 'command_help', 'run_command', 'final_answer'],
    'the commands, then the way to every other command, then the answer',
  );
});

Deno.test('a script the user ran comes back to the model with what it printed', () => {
  const [note] = transcriptFromChat([{
    role: 'assistant',
    content: 'Done:\n• Visa vikten',
    outcome: { of: '3', status: 'ran', results: [{ command: 'cat /w', ok: true, exitCode: 0, output: '{"value":83.4}\n{"value":82.4}\n' }] },
  }]);
  assertEquals(note, { role: 'user', content: '(the app: Done:\n• Visa vikten\nIt printed:\n{"value":83.4}\n{"value":82.4})' });
});
