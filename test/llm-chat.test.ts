/**
 * `llm-chat`: one question to the model, its system text and earlier turns ahead of it, its answer
 * printed. It is what `CFG_LANGUAGE_MODEL` names, so the guest may use it only where the archive
 * is open to it.
 */

import { assertEquals } from '@std/assert';
import type { LanguageModelReply } from '@ein/api';
import { createTestContext, type ShellClient, testCommands } from '@ein/testing';
import { startStubLlm } from './stub-llm.ts';

const testCtx = createTestContext({ modules: ['assistant'] });
let client: ShellClient;

Deno.test({ name: 'llm-chat', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  await testCtx.setup();
  client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);
  const model = startStubLlm(() => 'Oslo.');

  try {
    await t.step('the system text, the earlier turns and the message go in order, and no tools', async () => {
      const history = JSON.stringify([{ role: 'user', content: 'Huvudstaden i Sverige?' }, { role: 'assistant', content: 'Stockholm.' }]);
      const reply = await client.execJson<LanguageModelReply>(
        `CFG_LLM_URL=${model.url} llm-chat --system 'Svara med ett ord.' --history '${history}' --max-tokens 8 'Och i Norge?'`,
      );
      assertEquals(reply.content, 'Oslo.');
      const sent = model.requests.at(-1)!;
      assertEquals(sent.messages.map((message) => [message.role, message.content]), [
        ['system', 'Svara med ett ord.'],
        ['user', 'Huvudstaden i Sverige?'],
        ['assistant', 'Stockholm.'],
        ['user', 'Och i Norge?'],
      ]);
      assertEquals(sent.tools, undefined);
      assertEquals(sent.max_tokens, 8);
    });

    await t.step('without JSON it prints the answer', async () => {
      assertEquals(`${(await client.exec(`JSON_OUTPUT=0 CFG_LLM_URL=${model.url} llm-chat hej`)).data}`.trim(), 'Oslo.');
    });

    await t.step('without --think, CFG_LLM_THINKING decides; with it, the model thinks', async () => {
      const kwargs = () => (model.requests.at(-1) as { chat_template_kwargs?: unknown }).chat_template_kwargs;
      await client.execJson(`CFG_LLM_URL=${model.url} llm-chat hej`);
      assertEquals(kwargs(), undefined);
      await client.execJson(`CFG_LLM_THINKING=1 CFG_LLM_URL=${model.url} llm-chat hej`);
      assertEquals(kwargs(), { enable_thinking: true });
      await client.execJson(`CFG_LLM_THINKING=0 CFG_LLM_URL=${model.url} llm-chat --think hej`);
      assertEquals(kwargs(), { enable_thinking: true });
    });

    await t.step('a model that does not answer is a failure, for the caller to fall back from', async () => {
      await cmd.shouldFailWith('CFG_LLM_URL=http://127.0.0.1:1 llm-chat hej', 'llm-chat:');
      await cmd.shouldFailWith(`CFG_LLM_URL=${model.url} llm-chat --history '{}' hej`, '--history');
    });

    await t.step('the guest is refused until the archive is open to it', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      const asked = model.requests.length;
      try {
        assertEquals((await guest.exec(`CFG_LLM_URL=${model.url} llm-chat hej`)).success, false);
        // Its own command line does not open the archive to it.
        assertEquals((await guest.exec(`CFG_GUEST_BROWSING=true CFG_LLM_URL=${model.url} llm-chat hej`)).success, false);
        assertEquals(model.requests.length, asked);

        await cmd.shouldSucceed('config set CFG_GUEST_BROWSING true');
        assertEquals((await guest.execJson<LanguageModelReply>(`CFG_LLM_URL=${model.url} llm-chat hej`)).content, 'Oslo.');
      } finally {
        await cmd.shouldSucceed('config unset CFG_GUEST_BROWSING');
        guest.close();
      }
    });
  } finally {
    await model.close();
    client.close();
    await testCtx.teardown();
  }
});
