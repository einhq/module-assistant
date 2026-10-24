/**
 * llm-status against a stub llm: the plain command says what the host profile says and asks the
 * model nothing; `--checks` says whose it is and where, whether it answers, and whether its model is
 * one the assistant was tried with. The guest of a closed archive asks nothing of it.
 */

import { assertEquals } from '@std/assert';
import { createTestContext } from '@ein/testing';
import type { HealthCheck } from '@ein/client';
import type { LlmStatus } from '@assistant/api';

const testCtx = createTestContext({ modules: ['assistant'] });

Deno.test({
  name: 'llm-status',
  sanitizeResources: false,
  sanitizeOps: false,
}, async (t) => {
  await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  let llmUp = true;
  let offered = ['qwen3.5-4b'];
  const llmAsked: { path: string; key: string | null }[] = [];
  const llm = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, (req) => {
    llmAsked.push({ path: new URL(req.url).pathname, key: req.headers.get('authorization') });
    if (!llmUp) return new Response('loading', { status: 503 });
    return Response.json({ object: 'list', data: offered.map((id) => ({ id, object: 'model' })) });
  });
  const llmUrl = `http://127.0.0.1:${llm.addr.port}`;
  const ours = (card: string, flags = '') => `CFG_LLM_URL=${llmUrl} CFG_LLM_CARD=${card} llm-status ${flags}`;
  const external = (flags = '', url = llmUrl) => `CFG_LLM_URL=${url} CFG_LLM_PROVIDER='Example AI' CFG_LLM_MODEL=big-model llm-status ${flags}`;
  const base = { url: llmUrl, model: 'qwen3.5-4b', kind: 'ours' as const };

  try {
    await t.step('ours, and a provider, are not asked', async () => {
      const before = llmAsked.length;
      assertEquals(await client.execJson<LlmStatus>(ours('card')), { ...base, card: 'card' });
      assertEquals(await client.execJson<LlmStatus>(ours('cpu')), { ...base, card: 'cpu' });
      assertEquals(await client.execJson<LlmStatus>(external()), { url: llmUrl, model: 'big-model', kind: 'external', provider: 'Example AI' });
      assertEquals(llmAsked.length, before);
    });

    await t.step('checks: ours answering, on the card', async () => {
      const checks = await client.execJson<HealthCheck[]>(ours('card', '--checks'));
      assertEquals(checks, [{ name: 'llm', state: 'ok', reason: `ours, qwen3.5-4b at ${llmUrl}, on the card` }]);
    });

    await t.step('checks: ours with a model it was not tried with, on the CPU', async () => {
      offered = ['other-7b'];
      const checks = await client.execJson<HealthCheck[]>(ours('cpu', '--checks'));
      assertEquals(checks.map((check) => [check.name, check.state]), [['llm', 'ok'], ['llm model', 'warn']]);
      assertEquals(checks[0].reason, `ours, other-7b at ${llmUrl}, on the CPU`);
      assertEquals(checks[1].reason.startsWith('other-7b is untried'), true);
      offered = ['qwen3.5-4b'];
    });

    await t.step('checks: ours not answering', async () => {
      llmUp = false;
      const checks = await client.execJson<HealthCheck[]>(ours('card', '--checks'));
      assertEquals(checks, [{ name: 'llm', state: 'warn', reason: `${llmUrl} is not answering; the chat cannot answer until it does` }]);
      llmUp = true;
    });

    await t.step('checks: a provider is asked with its key, named, and its model checked', async () => {
      // The system's own address, and its key as the administrator's settings hold them.
      await client.exec(`echo "export CFG_LLM_URL='${llmUrl}'" >> /etc/config && echo "export CFG_LLM_KEY='sk-test'" > /etc/keys`);
      offered = ['big-model', 'small-model'];
      const checks = await client.execJson<HealthCheck[]>(external('--checks'));
      assertEquals(llmAsked.at(-1), { path: '/v1/models', key: 'Bearer sk-test' });

      // The key is the system's address's: the same server under another name is asked without it.
      await client.execJson<HealthCheck[]>(external('--checks', llmUrl.replace('127.0.0.1', '127.0.0.1.')));
      assertEquals(llmAsked.at(-1), { path: '/v1/models', key: null });

      assertEquals(checks[0], {
        name: 'llm',
        state: 'ok',
        reason: `Example AI's big-model at ${llmUrl}: questions, and what the assistant reads to answer them, leave this host`,
      });
      assertEquals(checks.slice(1).map((check) => check.reason.split(':')[0]), ['big-model is untried']);

      offered = ['small-model'];
      const missing = await client.execJson<HealthCheck[]>(external('--checks'));
      assertEquals(missing.map((check) => check.reason.split(';')[0]), [
        `Example AI's big-model at ${llmUrl}: questions, and what the assistant reads to answer them, leave this host`,
        'Example AI does not offer big-model',
        'big-model is untried: the prompts, the fast path and the eval set are tuned for qwen3.5-4b',
      ]);
    });

    await t.step('brief: the checks in a line', async () => {
      offered = ['qwen3.5-4b'];
      const line = await client.execString(`JSON_OUTPUT=0 ${ours('card', '--brief')}`);
      assertEquals(line.trim(), `ours, qwen3.5-4b at ${llmUrl}, on the card`);
    });

    await t.step('the guest of a closed archive is asked to sign in, and the model is not asked', async () => {
      const guest = await testCtx.server.createShellClient({ login: false });
      try {
        const before = llmAsked.length;
        assertEquals((await guest.exec(ours('card'))).error?.includes('sign in first'), true);
        assertEquals((await guest.exec(external('--checks'))).error?.includes('sign in first'), true);
        assertEquals(llmAsked.length, before);
      } finally {
        guest.close();
      }
    });
  } finally {
    await llm.shutdown();
    await testCtx.teardown();
  }
});
