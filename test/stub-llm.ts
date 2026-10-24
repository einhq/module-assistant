/**
 * An OpenAI-compatible chat endpoint on loopback, for the assistant's tests.
 *
 * It answers `/v1/chat/completions` with what a script says next — a plain reply, or a tool call
 * sent back the way the API sends one (`tool_calls`, arguments as a JSON string) — and records every
 * request, so a test can check what the model service was sent as well as what came of it. A request
 * with `stream: true` gets the same answer as server-sent deltas, a few characters each, the way
 * llama.cpp streams: the call's name first, then its arguments, `timings` on the last chunk. With
 * `away`, the first requests get llama.cpp's 503 while it loads its model instead.
 *
 * It counts a token per four characters of the messages and tools, and says so as llama.cpp does.
 * With `context`, `/props` gives that as the model's context (unless `props` is false), and a
 * longer request gets llama.cpp's 400 for it.
 */

export type StubMessage = {
  role: string;
  content?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
};
export type StubRequest = { model: string; messages: StubMessage[]; tools?: { type: string; function: { name: string } }[]; max_tokens?: number; stream?: boolean };
/**
 * A reply in words, or a call to one of the tools — with what the model thought first, and said beside it.
 * `cut`: the call stops part-way through its arguments, as one that reached `max_tokens` does.
 * `thought`: the model thinks until `max_tokens` and writes nothing else.
 */
export type StubReply = string | { tool: string; args?: Record<string, unknown>; cut?: boolean; reasoning?: string; content?: string } | { thought: string };
type StubCall = Extract<StubReply, { tool: string }>;

/** The tokens a request comes to, by the stub's count. */
export const stubTokens = (request: Pick<StubRequest, 'messages' | 'tools'>): number =>
  Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools ?? [] }).length / 4);

/** A call's arguments as sent: the JSON, or the first half of it for a call cut at the limit. */
const argumentsOf = (reply: StubCall): string => {
  const json = JSON.stringify(reply.args ?? {});
  return reply.cut ? json.slice(0, Math.floor(json.length / 2)) : json;
};
const finishOf = (reply: StubReply): string => typeof reply === 'string' ? 'stop' : 'thought' in reply || reply.cut ? 'length' : 'tool_calls';

/** Pieces of a streamed text, this long each. */
const PIECE = 6;
const pieces = (text: string): string[] => text ? Array.from({ length: Math.ceil(text.length / PIECE) }, (_, i) => text.slice(i * PIECE, (i + 1) * PIECE)) : [];

/** The reply as llama.cpp streams it: deltas, a last chunk with `finish_reason` and `timings`, then `[DONE]`. */
const streamed = (model: string, id: string, reply: StubReply, callId: string, chunkDelayMs: number, timings: Record<string, number>): Response => {
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });
  const chunks: Record<string, unknown>[] = typeof reply === 'string'
    ? pieces(reply).map((content) => chunk({ content }))
    : 'thought' in reply
    ? pieces(reply.thought).map((reasoning_content) => chunk({ reasoning_content }))
    : [
      ...pieces(reply.reasoning ?? '').map((reasoning_content) => chunk({ reasoning_content })),
      ...pieces(reply.content ?? '').map((content) => chunk({ content })),
      chunk({ tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: reply.tool, arguments: '' } }] }),
      ...pieces(argumentsOf(reply)).map((args) => chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] })),
    ];
  chunks.push({
    id,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishOf(reply) }],
    timings,
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const data of chunks) {
        if (chunkDelayMs) await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
};

export const startStubLlm = (
  answer: (request: StubRequest) => StubReply,
  opts: { delayMs?: number; chunkDelayMs?: number; away?: number; context?: number; props?: boolean } = {},
) => {
  const requests: StubRequest[] = [];
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (path === '/props' && opts.context && opts.props !== false) return Response.json({ default_generation_settings: { n_ctx: opts.context } });
    if (path !== '/v1/chat/completions') return new Response('not found', { status: 404 });
    const body = await req.json() as StubRequest;
    requests.push(body);
    if (requests.length <= (opts.away ?? 0)) return Response.json({ error: { code: 503, message: 'Loading model', type: 'unavailable_error' } }, { status: 503 });
    const tokens = stubTokens(body);
    if (opts.context && tokens > opts.context) {
      const message = `request (${tokens} tokens) exceeds the available context size (${opts.context} tokens), try increasing it`;
      return Response.json({ error: { code: 400, message, type: 'exceed_context_size_error', n_prompt_tokens: tokens, n_ctx: opts.context } }, { status: 400 });
    }
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    let reply: StubReply;
    try {
      reply = answer(body);
    } catch (error) {
      // A script that did not expect the conversation is the test's failure: say what it saw.
      console.log(`script rejected: ${error instanceof Error ? error.message : error}`);
      return new Response(String(error), { status: 500 });
    }
    // A call cut at the limit wrote all it was allowed.
    const written = typeof reply !== 'string' && ('thought' in reply || reply.cut) ? body.max_tokens ?? 768 : 5;
    const timings = { prompt_n: tokens, cache_n: 0, predicted_n: written };
    if (body.stream) return streamed(body.model, `chatcmpl-${requests.length}`, reply, `call_${requests.length}`, opts.chunkDelayMs ?? 0, timings);
    const message = typeof reply === 'string'
      ? { role: 'assistant', content: reply }
      : 'thought' in reply
      ? { role: 'assistant', content: '', reasoning_content: reply.thought }
      : {
        role: 'assistant',
        content: reply.content ?? '',
        ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
        tool_calls: [{ id: `call_${requests.length}`, type: 'function', function: { name: reply.tool, arguments: argumentsOf(reply) } }],
      };
    return Response.json({
      id: `chatcmpl-${requests.length}`,
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message, finish_reason: finishOf(reply) }],
      usage: { prompt_tokens: tokens, completion_tokens: written, total_tokens: tokens + written },
    });
  });
  return { url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`, requests, close: () => server.shutdown() };
};
