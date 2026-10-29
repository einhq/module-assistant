/**
 * The commands prompt is a file an operator can edit: `mod setup` installs it into /etc, never over
 * an edited copy, and the per-request context goes after it so the text stays a stable prefix.
 */

import { assert, assertEquals } from '@std/assert';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { COMMANDS_PROMPT_PATH, commandsSystem, stampedMessage } from '../lib/prompt-native.ts';

const shipped = await Deno.readTextFile(new URL('../etc/assistant-prompt.md', import.meta.url));

Deno.test('the per-request context follows the prompt text, which is unchanged', () => {
  const system = commandsSystem(shipped, { user: { name: 'Anna Exempel', path: '/archive/people/Anna_Exempel' } });
  assert(system.startsWith(shipped.trim()), 'the file is a prefix of every system message');
  assert(system.slice(shipped.trim().length).includes('Anna_Exempel'), 'the user comes after it');
  // Nothing that changes per message is in it: the time travels with each user message.
  assertEquals(commandsSystem(shipped, { user: { name: 'Anna Exempel', path: '/archive/people/Anna_Exempel' } }), system);
  assert(!/\d{4}-\d{2}-\d{2}/.test(system.slice(shipped.trim().length)), 'no date in the system message');
});

Deno.test("the context names the system's language, English when none is set", () => {
  assert(commandsSystem(shipped, { language: 'sv' }).includes("The system's language is Swedish."));
  assert(commandsSystem(shipped, {}).includes("The system's language is English."));
});

Deno.test('a user message carries its own time and what the app showed', () => {
  const at = new Date(2026, 0, 6, 9, 5);
  assertEquals(stampedMessage('hej', at), '[Tue 2026-01-06 09:05] hej');
  assertEquals(stampedMessage('den här', at, { lightbox: '/archive/albums/A/files/x.jpg' }), '[Tue 2026-01-06 09:05 · open picture /archive/albums/A/files/x.jpg] den här');
});

Deno.test('the stamp says in words which screen is open, how it is set and its node; an address only for a nameless one', () => {
  const at = new Date(2026, 0, 6, 9, 5);
  assertEquals(stampedMessage('vad är det här?', at, { route: '/settings' }), '[Tue 2026-01-06 09:05 · on screen: web address /settings] vad är det här?');
  assertEquals(
    stampedMessage('vad är det här?', at, { route: '/settings?tab=modules', section: 'Settings', title: 'Settings', about: 'How this installation is configured' }),
    '[Tue 2026-01-06 09:05 · on screen: Settings, "How this installation is configured", ?tab=modules] vad är det här?',
  );
  assertEquals(
    stampedMessage('vem är det?', at, {
      route: '/people/Anna_Exempel?tab=family',
      section: 'People',
      title: 'Anna Exempel',
      node: '/archive/people/Anna_Exempel',
      lightbox: '/archive/albums/A/files/x.jpg',
    }),
    '[Tue 2026-01-06 09:05 · on screen: People › Anna Exempel, ?tab=family, about node /archive/people/Anna_Exempel · open picture /archive/albums/A/files/x.jpg] vem är det?',
  );
});

const testCtx = createTestContext({ modules: ['assistant'], boot: true });
let client: ShellClient;

Deno.test({
  name: 'mod setup installs the prompt and keeps an edited one',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  try {
    await t.step('the shipped text is in /etc', async () => {
      const installed = await client.exec(`cat ${COMMANDS_PROMPT_PATH}`);
      assertEquals(installed.success, true);
      assertEquals(`${installed.data}`.trim(), shipped.trim());
    });

    await t.step('setup again leaves an edit alone', async () => {
      await cmd.shouldSucceed(`echo 'Svara kort.' > ${COMMANDS_PROMPT_PATH}`);
      await cmd.shouldSucceed('mod setup assistant');
      const after = await client.exec(`cat ${COMMANDS_PROMPT_PATH}`);
      assertEquals(`${after.data}`.trim(), 'Svara kort.');
    });
  } finally {
    client.close();
    await testCtx.teardown();
  }
});
