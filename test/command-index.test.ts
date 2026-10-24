/**
 * The command index: every command on PATH, found by what it is for and judged by its own spec.
 *
 * The text embedder (`CFG_TEXT_EMBEDDER`) is a command of the test's own that hashes words into a
 * small vector, so texts that share words are near and others are not — enough to check that the
 * vector is used, without a model. With no embedder the words alone still find commands.
 */

import { assert, assertEquals } from '@std/assert';
import { ADMIN_ACCESS, createTestContext, type ShellClient } from '@ein/testing';

const testCtx = createTestContext({ modules: ['assistant'] });

/** A bag of words as a vector: each word, its plural dropped, adds to one hashed slot. Each call is noted in /tmp/embedded. */
const FAKE_EMBED = `#!ts
const DIMENSION = 64;
const bagOfWords = (text) => {
  const vector = new Array(DIMENSION).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2)) {
    const stem = word.replace(/s$/, '');
    let hash = 0;
    for (const char of stem) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    vector[hash % DIMENSION] += 1;
  }
  return vector;
};
const fakeEmbed = async (cmd) => {
  if (cmd.args.includes('--model')) {
    await cmd.writeJSON({ model: 'bag-of-words', vectors: [] });
    return 0;
  }
  await cmd.execute('echo x >> /tmp/embedded');
  const texts = cmd.args.filter((arg, i) => !arg.startsWith('--') && !['--role', '--timeout'].includes(cmd.args[i - 1]));
  await cmd.writeJSON({ model: 'bag-of-words', vectors: texts.map(bagOfWords) });
  return 0;
};
fakeEmbed.spec = { name: 'fake-embed', effect: 'read', description: 'Texts as bags of words', args: [], flags: [] };
export default fakeEmbed;
`;

type Hit = { name: string; effect?: string; score: number };

Deno.test({ name: 'command-index', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const setup: ShellClient = await testCtx.server.createShellClient();
  // A module of the test's own, since a #!ts command runs only from one.
  await setup.exec('mkdir -p $MOD_PATH/fake-embedder/bin && echo \'{"name":"fake-embedder","version":"1.0.0"}\' > $MOD_PATH/fake-embedder/mod.json');
  await setup.exec('mkfile $MOD_PATH/fake-embedder/bin/fake-embed && chmod 755 $MOD_PATH/fake-embedder/bin/fake-embed');
  const bin = `${`${(await setup.exec('echo $MOD_PATH')).data}`.trim()}/fake-embedder/bin/fake-embed`;
  const handle = await vfs.open(ADMIN_ACCESS, bin, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(FAKE_EMBED));
  } finally {
    await handle.close();
  }
  await setup.exec('mod-setup fake-embedder');
  setup.close();
  // A shell opened after the setup has its bin on PATH.
  const client: ShellClient = await testCtx.server.createShellClient();
  const embedded = async () => `${(await client.exec('cat /tmp/embedded')).data ?? ''}`.split('\n').filter(Boolean).length;
  const EMBEDDER = 'CFG_TEXT_EMBEDDER=fake-embed';
  // The first find builds the index: ~300 commands embedded four at a time, about 4 s on a quiet
  // machine and more beside the rest of the fast tier, so the harness's 5 s default is too tight.
  const find = async (words: string, env = EMBEDDER) => (await client.execJson<{ hits: Hit[] }>(`${env} assistant-commands find '${words}'`, { timeout: 60_000 })).hits;
  try {
    await t.step('a command is found by what it is for, and says whether it changes anything', async () => {
      const hits = await find('list running services');
      assertEquals(hits[0].name, 'service-list');
      assertEquals(hits[0].effect, 'read');
      const restart = await find('restart a service');
      assert(restart.slice(0, 3).some((hit) => hit.name === 'service-restart' && hit.effect === 'write'), JSON.stringify(restart.slice(0, 3)));
      // Every command on PATH was embedded: one call per command, and one per query.
      assert(await embedded() > 100);
    });

    await t.step('completion helpers, daemons and the assistant itself are not found', async () => {
      const names = (await find('complete a command name')).map((hit) => hit.name);
      assert(!names.some((name) => name.startsWith('completion')), names.join(' '));
      assert(!(await find('pipeline engine')).some((hit) => hit.name === 'pipeline-engine'));
      assert(!(await find('ask the assistant')).some((hit) => hit.name === 'assistant-ask'));
    });

    await t.step('the index is kept in the home, and a rebuild asks nothing it knows again', async () => {
      assertEquals((await client.exec('ls ~/.cache')).data?.toString().includes('assistant-commands.json'), true);
      const before = await embedded();
      // Forgotten in memory, read back from the home: nothing is embedded again.
      await client.execJson(`${EMBEDDER} assistant-commands reindex`, { timeout: 60_000 });
      assertEquals(await embedded(), before);
    });

    await t.step('without an embedder, or with one that fails, the words still find a command', async () => {
      for (const env of ['CFG_TEXT_EMBEDDER=', 'CFG_TEXT_EMBEDDER=false']) {
        await client.execJson(`${env} assistant-commands reindex`);
        assertEquals((await find('service list', env))[0].name, 'service-list');
      }
    });

    await t.step("core's docs commands gives every command with its spec and module, hiding nothing", async () => {
      type Listed = { name: string; module: string; spec: { name: string; description?: string } };
      const commands = await client.execJson<Listed[]>('docs commands');
      const byName = new Map(commands.map((entry) => [entry.name, entry]));
      assertEquals(byName.get('ls')?.module, 'core');
      assertEquals(byName.get('assistant-commands')?.module, 'assistant');
      assertEquals(byName.get('assistant-commands')?.spec.name, 'assistant-commands');
      // What the assistant may not run or is not offered is still a command the reader can run.
      assert(byName.has('assistant-ask') && byName.has('completion-arg') && byName.has('service'));
      assertEquals(commands.map((entry) => entry.name), commands.map((entry) => entry.name).toSorted((a, b) => a.localeCompare(b)));
    });

    await t.step('a line is judged by the specs in the index', async () => {
      const judge = (line: string) => client.execJson<{ effect: string; reasons: string[] }>(`${EMBEDDER} assistant-commands judge '${line}'`);
      assertEquals((await judge('service-list | jq .')).effect, 'read');
      assertEquals(await judge('service restart pipeline-pruner'), { effect: 'write', reasons: ['service-restart changes something'] });
      assertEquals((await judge('frobnicate')).reasons, ['frobnicate is not a known command']);
    });
  } finally {
    await testCtx.teardown();
  }
});
