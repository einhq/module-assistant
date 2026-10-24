import { assert, assertEquals, assertRejects } from '@std/assert';
import { ADMIN_ACCESS, type Command } from '@ein/client';
import { chat, contextTokens, LlmContextError, type LlmDraft, LlmUnavailableError } from '../lib/llm.ts';
import { startStubLlm, stubTokens } from './stub-llm.ts';

/** A VFS with no settings files: no key is set. */
const sys = { vfs: { open: () => Promise.reject(new Error('no such node')), children: () => Promise.reject(new Error('no such node')) } };
const commandAt = (url: string) => ({ access: ADMIN_ACCESS, env: { CFG_LLM_URL: url }, interrupted: false, sys }) as unknown as Command;
const said = [{ role: 'user' as const, content: 'hej' }];

Deno.test('a streamed answer is the one-piece answer, and the draft grows as it arrives', async () => {
  const model = startStubLlm(() => ({ tool: 'final_answer', args: { answer: 'Två bilder från "Italien".' } }));
  try {
    const whole = await chat(commandAt(model.url), said);
    const drafts: string[] = [];
    const streamed = await chat(commandAt(model.url), said, { onDraft: (draft: LlmDraft) => drafts.push(draft.calls[0]?.arguments ?? '') });
    assertEquals(model.requests.map((request) => request.stream), [undefined, true]);
    assertEquals(streamed.calls.map(({ name, args }) => ({ name, args })), whole.calls.map(({ name, args }) => ({ name, args })));
    assertEquals(streamed.calls[0].id, 'call_2');
    assertEquals(streamed.read, stubTokens({ messages: said }));
    assertEquals(streamed.reused, 0);
    assert(drafts.length > 3, `${drafts.length} drafts`);
    for (let i = 1; i < drafts.length; i++) assert(drafts[i].startsWith(drafts[i - 1]), 'each draft extends the one before');
    assertEquals(JSON.parse(drafts.at(-1)!), { answer: 'Två bilder från "Italien".' });
  } finally {
    await model.close();
  }
});

Deno.test('streamed words come back as content', async () => {
  const model = startStubLlm(() => 'Hej! Vad vill du se?');
  try {
    let last = '';
    const reply = await chat(commandAt(model.url), said, { onDraft: (draft) => last = draft.content });
    assertEquals(reply.content, 'Hej! Vad vill du se?');
    assertEquals(reply.calls, []);
    assertEquals(last, 'Hej! Vad vill du se?');
  } finally {
    await model.close();
  }
});

Deno.test('an error in the stream is the service being unavailable', async () => {
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    await req.body?.cancel();
    return new Response(`data: {"choices":[{"delta":{"content":"Hej"}}]}\n\ndata: {"error":{"message":"context full"}}\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  try {
    const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    await assertRejects(() => chat(commandAt(url), said, { onDraft: () => {} }), LlmUnavailableError, 'context full');
  } finally {
    await server.shutdown();
  }
});

Deno.test('CFG_LLM_THINKING asks the server to think or not; unset, the request stays standard', async () => {
  const model = startStubLlm(() => 'ok');
  try {
    const at = (thinking?: string) =>
      ({ access: ADMIN_ACCESS, env: { CFG_LLM_URL: model.url, ...(thinking ? { CFG_LLM_THINKING: thinking } : {}) }, interrupted: false, sys }) as unknown as Command;
    const plain = await chat(at(), said);
    await chat(at('1'), said);
    await chat(at('0'), said);
    const sent = model.requests.map((request) => (request as { chat_template_kwargs?: unknown }).chat_template_kwargs);
    assertEquals(sent, [undefined, { enable_thinking: true }, { enable_thinking: false }]);
    assertEquals(plain.cut, undefined);
    assertEquals(plain.generated, 5);
  } finally {
    await model.close();
  }
});

/** A server whose every request is answered by `respond`, the first one being number 1. */
const serve = (respond: (n: number) => Response) => {
  let n = 0;
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    await req.body?.cancel();
    return respond(++n);
  });
  return { url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, asked: () => n, close: () => server.shutdown() };
};
const LOADING = () => Response.json({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }, { status: 503 });
const encoder = new TextEncoder();

/** Reads one request off the connection, to its last byte: a request left unread would reset the connection. */
const readRequest = async (conn: Deno.Conn) => {
  const buffer = new Uint8Array(65536);
  let text = '';
  for (;;) {
    const read = await conn.read(buffer);
    if (read === null) return;
    text += new TextDecoder().decode(buffer.subarray(0, read));
    const head = text.indexOf('\r\n\r\n');
    const length = Number(/content-length: *(\d+)/i.exec(text)?.[1] ?? 0);
    if (head >= 0 && encoder.encode(text).length - head - 4 >= length) return;
  }
};

/**
 * A server that dies in the middle of its `n`th answer, as one does when it is killed: the head of a
 * streamed answer, `words` as one delta, and the connection dropped — or, `whole`, the stream ended.
 */
const dying = (answer: (n: number) => { words: string; whole?: boolean }) => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  let n = 0;
  const serving = (async () => {
    for await (const conn of listener) {
      const { words, whole } = answer(++n);
      await readRequest(conn);
      const frames = `${words ? `data: {"choices":[{"delta":{"content":"${words}"}}]}\n\n` : ''}${whole ? 'data: [DONE]\n\n' : ''}`;
      const chunk = frames ? `${encoder.encode(frames).length.toString(16)}\r\n${frames}\r\n` : '';
      await conn.write(
        encoder.encode(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n${chunk}${whole ? '0\r\n\r\n' : ''}`),
      );
      conn.close();
    }
  })();
  return {
    url: `http://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    asked: () => n,
    close: async () => {
      listener.close();
      await serving.catch(() => {});
    },
  };
};

Deno.test('a model that is loading is asked again until it answers, and the wait is told and timed', async () => {
  const model = startStubLlm(() => 'Hej!', { away: 1 });
  try {
    const heard: boolean[] = [];
    const reply = await chat(commandAt(model.url), said, { wait: true, onAway: (away) => heard.push(away) });
    assertEquals(reply.content, 'Hej!');
    assertEquals(heard, [true, false]);
    assert(reply.awayMs !== undefined && reply.awayMs >= 900, `awayMs ${reply.awayMs}`);
    assertEquals(model.requests.length, 2);
  } finally {
    await model.close();
  }
});

Deno.test('a stream cut before a word is asked again; one cut after a word is not', async () => {
  const before = dying((n) => ({ words: n === 1 ? '' : 'Hej', whole: n > 1 }));
  const after = dying(() => ({ words: 'Hej' }));
  try {
    assertEquals((await chat(commandAt(before.url), said, { wait: true, onDraft: () => {} })).content, 'Hej');
    assertEquals(before.asked(), 2);
    await assertRejects(() => chat(commandAt(after.url), said, { wait: true, onDraft: () => {} }), LlmUnavailableError);
    assertEquals(after.asked(), 1);
  } finally {
    await before.close();
    await after.close();
  }
});

Deno.test('an answer the service gave is not asked again', async () => {
  const refused = serve(() => new Response('bad request', { status: 400 }));
  try {
    const heard: boolean[] = [];
    await assertRejects(() => chat(commandAt(refused.url), said, { wait: true, onAway: (away) => heard.push(away) }), LlmUnavailableError, 'HTTP 400');
    assertEquals(refused.asked(), 1);
    assertEquals(heard, []);
  } finally {
    await refused.close();
  }
});

Deno.test('a request longer than the context is refused for its length, not the service being away', async () => {
  const context = stubTokens({ messages: said }) - 1;
  const model = startStubLlm(() => 'ok', { context, props: false });
  try {
    const refused = await assertRejects(() => chat(commandAt(model.url), said, { wait: true }), LlmContextError, 'exceeds the available context size');
    assertEquals([refused.tokens, refused.limit], [context + 1, context]);
    assertEquals(model.requests.length, 1, 'not asked again');
    // The refusal said how much fits, though `/props` did not.
    assertEquals(await contextTokens(commandAt(model.url)), context);
    // Streamed, it is refused the same way.
    await assertRejects(() => chat(commandAt(model.url), said, { onDraft: () => {} }), LlmContextError);
  } finally {
    await model.close();
  }
});

Deno.test("the model's context is what llama.cpp's /props says, and unknown where there is none", async () => {
  const model = startStubLlm(() => 'ok', { context: 32768 });
  const hosted = startStubLlm(() => 'ok');
  try {
    assertEquals(await contextTokens(commandAt(model.url)), 32768);
    assertEquals(await contextTokens(commandAt(hosted.url)), undefined);
    // The whole prompt and what was written come back counted.
    const reply = await chat(commandAt(model.url), said);
    assertEquals([reply.prompt, reply.generated], [stubTokens({ messages: said }), 5]);
  } finally {
    await model.close();
    await hosted.close();
  }
});

Deno.test('a caller that does not wait is told at once; CFG_LLM_WAIT bounds the wait, and 0 does not wait', async () => {
  const loading = serve(LOADING);
  const at = (wait: string) => ({ access: ADMIN_ACCESS, env: { CFG_LLM_URL: loading.url, CFG_LLM_WAIT: wait }, interrupted: false, sys }) as unknown as Command;
  try {
    await assertRejects(() => chat(at('60'), said), LlmUnavailableError, 'HTTP 503');
    await assertRejects(() => chat(at('0'), said, { wait: true }), LlmUnavailableError, 'HTTP 503');
    assertEquals(loading.asked(), 2);
    const startedAt = Date.now();
    await assertRejects(() => chat(at('2'), said, { wait: true }), LlmUnavailableError, 'still away after 2s');
    assert(Date.now() - startedAt < 4000, `${Date.now() - startedAt} ms`);
    assertEquals(loading.asked(), 2 + 3);
  } finally {
    await loading.close();
  }
});

Deno.test('a stopped command stops waiting', async () => {
  const cmd = { ...commandAt('http://127.0.0.1:1'), interrupted: false } as { interrupted: boolean };
  setTimeout(() => cmd.interrupted = true, 300);
  const startedAt = Date.now();
  await assertRejects(() => chat(cmd as unknown as Command, said, { wait: true }), LlmUnavailableError, 'interrupted');
  assert(Date.now() - startedAt < 1000, `${Date.now() - startedAt} ms`);
});
