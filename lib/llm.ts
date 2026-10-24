/**
 * The assistant's language model, over the OpenAI Chat Completions API.
 *
 * WHY THIS API. It is the one every provider speaks: llama.cpp's own server, vLLM, Ollama,
 * LM Studio, and the hosted ones — OpenAI, OpenRouter, Mistral, Groq. Which one answers is
 * configuration, not code:
 *
 *   CFG_LLM_URL    the API's base, without `/v1` (default http://127.0.0.1:8190)
 *   CFG_LLM_MODEL  the model to ask for (llama.cpp serves the one it loaded, whatever this says)
 *   CFG_LLM_KEY    a bearer key, for a provider that wants one; a secret, sent only to the system's
 *                  own CFG_LLM_URL
 *   CFG_LLM_THINKING  1 or 0: think before answering, or not, overriding the server's default. Sent
 *                  as llama.cpp's `chat_template_kwargs`, so only for a server that reads it; unset,
 *                  nothing is sent and the server decides
 *   CFG_LLM_WAIT   seconds a caller that waits keeps asking a service that is away (default 180; 0
 *                  gives up at once)
 *
 * Only standard fields are sent, so a hosted API accepts the request as it is; what is particular
 * to a local model — thinking off, a chat template that keeps history stable for the cache — is
 * the server's to set. Tools go as the API's `tools` and come back as its `tool_calls`, parsed by
 * the server; a model that writes its call as text instead is still read, by the caller, from
 * `content`.
 *
 * NO SESSIONS HERE. Every request carries the whole conversation; the server compares it with what
 * its cache holds and reads only what is new. That works as long as the history is sent the same
 * way every time — which the stored transcript guarantees on this side, and the server's template
 * on that one.
 *
 * STREAMED WHEN SOMEONE IS WATCHING. A caller that passes `onDraft` gets the answer as the API's
 * `stream: true` sends it — words, reasoning and tool-call arguments as deltas — and is handed the
 * draft as it grows, which the drawer shows while the turn runs. The reply is put back together
 * into what the one-piece answer says, so nothing after this file can tell the difference.
 *
 * WAITED FOR WHEN AWAY, BY A CALLER THAT WAITS ANYWAY. A service that is not there — nothing
 * listens, the connection breaks before the model wrote a word, a 502–504, llama.cpp's 503 while it
 * loads its model — is asked again, with a growing pause, for up to `CFG_LLM_WAIT` seconds, when the
 * caller passes `wait`: a server restarts now and then, and a cold load takes over a minute. A
 * caller with something to fall back on, such as the search box's parser, is told at once. An answer
 * the service gave — a 4xx, an error in the stream, a reply we cannot read — is not asked again, nor
 * is a request that timed out or was stopped.
 *
 * TOO LONG IS NOT AWAY. A request longer than the model's context is refused with a 400 that says
 * so; it is an `LlmContextError`, with the counts when the service gives them, for the caller to
 * send less. How much fits is `contextTokens`: llama.cpp's `/props` says, and so does its refusal.
 *
 * NOT FOR EVERY GUEST. Whoever reaches the server without signing in is the guest, and the model's
 * time is not free: it serves the guest only where the archive is open to it (`mayUseModel`).
 */

import type { Command } from '@ein/client';
import { guestMayBrowse, isVisitor, serviceKey } from '@ein/client';

type LlmToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** A command's schema as the API wants a tool: `{ type: 'function', function: schema }`. */
export type LlmTool = { type: 'function'; function: unknown };

type LlmCall = { id: string; name: string; args: Record<string, unknown> };

type LlmReply = {
  content: string;
  calls: LlmCall[];
  model: string;
  /** What the model thought before answering, when the server has thinking on and says so. */
  reasoning?: string;
  /** Prompt tokens the server had to read, and the ones it reused from its cache, when it says. */
  read?: number;
  reused?: number;
  /** The whole prompt in tokens, read and reused together, when the server says. */
  prompt?: number;
  /** The answer stopped at `maxTokens` rather than where the model ended it: a call in it is unfinished. */
  cut?: boolean;
  /** Tokens it wrote, thought included. */
  generated?: number;
  /** How long the request waited for the service to come back, in ms, when it found it away. */
  awayMs?: number;
};

/** The model service did not answer: down, unreachable, or not an API we understand. */
export class LlmUnavailableError extends Error {}

/** The service is not there to answer — restarting, most likely — so the request is worth sending again. */
class LlmAwayError extends LlmUnavailableError {}

/**
 * The request is longer than the model can read: `tokens` it came to and the `limit` it had to fit,
 * when the service says (llama.cpp does; OpenAI says only that it did not fit).
 */
export class LlmContextError extends Error {
  constructor(message: string, readonly tokens?: number, readonly limit?: number) {
    super(message);
  }
}

/** The model's context in tokens, by service base: what `/props` or a refusal said. */
const contexts = new Map<string, number>();
/** Services whose `/props` says nothing of a context: a hosted API. Not asked again. */
const silent = new Set<string>();
const PROPS_TIMEOUT_MS = 2000;

/** The error the service answered with, when it is the request being too long for the context. */
const contextError = (base: string, raw: unknown): LlmContextError | undefined => {
  const error = asRecord(asRecord(raw)?.error);
  if (error?.type !== 'exceed_context_size_error' && error?.code !== 'context_length_exceeded') return undefined;
  const count = (value: unknown) => typeof value === 'number' && value > 0 ? value : undefined;
  const limit = count(error.n_ctx);
  if (limit) contexts.set(base, limit);
  return new LlmContextError(`${base}: ${String(error.message ?? 'longer than the context')}`, count(error.n_prompt_tokens), limit);
};

/**
 * How many tokens the model reads at most, prompt and answer together, when the service says:
 * llama.cpp's `/props`, or the refusal of a request that was too long. Unknown for a hosted API.
 */
export const contextTokens = async (cmd: Command): Promise<number | undefined> => {
  const base = llmBase(cmd);
  if (!contexts.has(base) && !silent.has(base)) {
    try {
      const response = await fetch(`${base}/props`, { headers: await llmAuth(cmd), signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) });
      const props = response.ok ? asRecord(await response.json().catch(() => undefined)) : undefined;
      if (!response.bodyUsed) await response.body?.cancel();
      const size = asRecord(props?.default_generation_settings)?.n_ctx;
      if (typeof size === 'number' && size > 0) contexts.set(base, size);
      // An answer without one, or no such page; a server still loading is asked again.
      else if (response.ok || response.status === 404) silent.add(base);
    } catch { /* away or slow: asked again next time */ }
  }
  return contexts.get(base);
};

/** A gateway in front of a server that is gone, or the server itself not ready: llama.cpp answers 503 while it loads. */
const AWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Whether the caller may use the model: anyone signed in; someone who has not — the guest, or a
 * share link's visitor — only where the archive is open to visitors.
 */
export const mayUseModel = async (cmd: Command): Promise<boolean> => !isVisitor(cmd.access) || await guestMayBrowse(cmd.sys.vfs);

const DEFAULT_LLM_URL = 'http://127.0.0.1:8190';
const DEFAULT_MODEL = 'qwen3.5-4b';
/** How long a request waits for a service that is away: a little longer than a cold load of the model on the card. */
const DEFAULT_WAIT_SECONDS = 180;
/** The pause between asks of a service that is away, doubling from the first to the last. */
const FIRST_PAUSE_MS = 1000;
const LAST_PAUSE_MS = 5000;

/**
 * The models the prompts, the fast path and the eval set (`eval/questions.json`) are tuned for, and
 * that `agent-eval` has measured doing the job. Any other answers too, but `health` calls it untried
 * until an `agent-eval` run against it says it does; then it is added here.
 */
export const TRIED_MODELS = ['qwen3.5-4b'];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const argsOf = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw)) ?? {};
    } catch {
      return {};
    }
  }
  return asRecord(raw) ?? {};
};

/**
 * What the model has written so far in a streamed answer: its reasoning (empty while thinking is off
 * on the server), its words, and its calls, their arguments still unfinished JSON.
 */
export type LlmDraft = { reasoning: string; content: string; calls: { name: string; arguments: string }[] };

type ChatOptions = {
  tools?: LlmTool[];
  maxTokens?: number;
  timeoutSeconds?: number;
  /**
   * Stream the answer, and hear what the model has written each time it writes more — the same
   * object, grown. The reply is the same as without it; a service that answers in one piece anyway
   * is read as such.
   */
  onDraft?: (draft: LlmDraft) => void;
  /** Think before answering, or not, whatever `CFG_LLM_THINKING` and the server say. */
  thinking?: boolean;
  /** Keep asking a service that is away, for up to `CFG_LLM_WAIT` seconds, rather than failing at once. */
  wait?: boolean;
  /** With `wait`: hear that the service is away and the request waits for it (true), and that the wait is over (false). */
  onAway?: (away: boolean) => void;
};

/** The body of a streamed answer (`text/event-stream`), put back together as the one-piece answer would read. */
const readStream = async (base: string, response: Response, signal: AbortSignal, onDraft?: (draft: LlmDraft) => void): Promise<Record<string, unknown>> => {
  const draft: LlmDraft = { reasoning: '', content: '', calls: [] };
  const ids: string[] = [];
  const whole: Record<string, unknown> = {};
  let finish: string | undefined;
  const take = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk: Record<string, unknown> | undefined;
    try {
      chunk = asRecord(JSON.parse(data));
    } catch {
      throw new LlmUnavailableError(`${base}: not JSON in the stream: ${data.slice(0, 200)}`);
    }
    if (!chunk) return;
    if (chunk.error) throw contextError(base, chunk) ?? new LlmUnavailableError(`${base}: ${JSON.stringify(chunk.error).slice(0, 300)}`);
    // llama.cpp puts `timings` on the last chunk; OpenAI sends `usage` on a last one of its own.
    for (const field of ['model', 'timings', 'usage']) if (chunk[field] !== undefined && chunk[field] !== null) whole[field] = chunk[field];
    const first = asRecord((chunk.choices as unknown[] | undefined)?.[0]);
    if (typeof first?.finish_reason === 'string') finish = first.finish_reason;
    const delta = asRecord(first?.delta);
    if (!delta) return;
    if (typeof delta.reasoning_content === 'string') draft.reasoning += delta.reasoning_content;
    if (typeof delta.content === 'string') draft.content += delta.content;
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const part = asRecord(raw) ?? {};
      const index = typeof part.index === 'number' ? part.index : Math.max(0, draft.calls.length - 1);
      const call = draft.calls[index] ??= { name: '', arguments: '' };
      if (typeof part.id === 'string' && part.id) ids[index] = part.id;
      const fn = asRecord(part.function) ?? {};
      if (typeof fn.name === 'string') call.name += fn.name;
      if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
    }
    onDraft?.(draft);
  };
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new LlmUnavailableError(`${base}: an empty stream`);
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += value;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) take(line.trim());
    }
    take(buffered.trim());
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof LlmUnavailableError || error instanceof LlmContextError) throw error;
    // Cut before the model wrote a word, and not by us: the server went away with the request unread.
    const unwritten = !signal.aborted && !draft.reasoning && !draft.content && !draft.calls.length;
    throw new (unwritten ? LlmAwayError : LlmUnavailableError)(`${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const toolCalls = draft.calls.map((call, i) => ({ id: ids[i], type: 'function', function: call }));
  const message = {
    role: 'assistant',
    content: draft.content,
    ...(draft.reasoning ? { reasoning_content: draft.reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
  return { ...whole, choices: [{ ...(finish ? { finish_reason: finish } : {}), message }] };
};

const readJson = async (base: string, response: Response, signal: AbortSignal): Promise<Record<string, unknown>> => {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new (signal.aborted ? LlmUnavailableError : LlmAwayError)(`${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmUnavailableError(`${base}: not JSON: ${text.slice(0, 200)}`);
  }
};

/** The chat API's base, without a trailing `/v1`. */
export const llmBase = (cmd: Command): string => (cmd.env.CFG_LLM_URL || DEFAULT_LLM_URL).replace(/\/+$/, '').replace(/\/v1$/, '');

/** The model to ask for. */
export const llmModel = (cmd: Command): string => cmd.env.CFG_LLM_MODEL || DEFAULT_MODEL;

/** The key a provider wants, as a request's headers: only for the system's own model address (`serviceKey`). */
export const llmAuth = async (cmd: Command): Promise<Record<string, string>> => {
  const key = await serviceKey(cmd, 'CFG_LLM_KEY', 'CFG_LLM_URL');
  return key ? { authorization: `Bearer ${key}` } : {};
};

/** One request to the service; `answered` hears that it answered at all, before its answer is read. */
const request = async (cmd: Command, messages: LlmMessage[], opts: ChatOptions, answered: () => void): Promise<LlmReply> => {
  const base = llmBase(cmd);
  const model = llmModel(cmd);
  const thinking = opts.thinking ?? (cmd.env.CFG_LLM_THINKING === '1' ? true : cmd.env.CFG_LLM_THINKING === '0' ? false : undefined);
  const controller = new AbortController();
  // Both cover the body as well as the headers: a streamed answer is generated while it is read.
  const timer = setTimeout(() => controller.abort(new Error('timed out')), (opts.timeoutSeconds ?? 180) * 1000);
  // Stopped means stopped: an interrupted turn must not leave the server generating for nobody.
  const watch = setInterval(() => {
    if (cmd.interrupted) controller.abort(new Error('interrupted'));
  }, 250);
  let body: Record<string, unknown>;
  try {
    let response: Response;
    try {
      response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...await llmAuth(cmd),
        },
        body: JSON.stringify({
          model,
          messages,
          ...(opts.tools?.length ? { tools: opts.tools } : {}),
          temperature: 0,
          max_tokens: opts.maxTokens ?? 768,
          ...(thinking !== undefined ? { chat_template_kwargs: { enable_thinking: thinking } } : {}),
          ...(opts.onDraft ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // Refused, reset, or no such host: away. Our own abort — out of time, or stopped — is not.
      const reason = `${base}: ${error instanceof Error ? error.message : String(error)}`;
      throw new (controller.signal.aborted ? LlmUnavailableError : LlmAwayError)(reason);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let said: unknown;
      try {
        said = JSON.parse(text);
      } catch { /* a gateway's page, or nothing */ }
      throw contextError(base, said) ??
        new (AWAY_STATUSES.has(response.status) ? LlmAwayError : LlmUnavailableError)(`${base}: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    answered();
    body = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ? await readStream(base, response, controller.signal, opts.onDraft)
      : await readJson(base, response, controller.signal);
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
  }
  const choice = asRecord((body.choices as unknown[] | undefined)?.[0]);
  const message = asRecord(choice?.message);
  if (!message) throw new LlmUnavailableError(`${base}: no choices in the answer`);
  const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((raw, i): LlmCall => {
    const call = asRecord(raw) ?? {};
    const fn = asRecord(call.function) ?? {};
    return { id: typeof call.id === 'string' && call.id ? call.id : `call_${i}`, name: String(fn.name ?? ''), args: argsOf(fn.arguments) };
  }).filter((call) => call.name);
  // llama.cpp reports its own counts in `timings`; OpenAI puts the cached share in `usage`.
  const timings = asRecord(body.timings);
  const usage = asRecord(body.usage);
  const cachedDetails = asRecord(usage?.prompt_tokens_details);
  const read = typeof timings?.prompt_n === 'number' ? timings.prompt_n : undefined;
  const reused = typeof timings?.cache_n === 'number' ? timings.cache_n : typeof cachedDetails?.cached_tokens === 'number' ? cachedDetails.cached_tokens : undefined;
  const prompt = read !== undefined && reused !== undefined ? read + reused : typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const generated = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : typeof timings?.predicted_n === 'number' ? timings.predicted_n : undefined;
  return {
    content: typeof message.content === 'string' ? message.content : '',
    calls,
    model: typeof body.model === 'string' && body.model ? body.model : model,
    ...(typeof message.reasoning_content === 'string' && message.reasoning_content.trim() ? { reasoning: message.reasoning_content.trim() } : {}),
    ...(read !== undefined ? { read } : {}),
    ...(reused !== undefined ? { reused } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(choice?.finish_reason === 'length' ? { cut: true } : {}),
    ...(generated !== undefined ? { generated } : {}),
  };
};

/** Seconds to keep asking a service that is away (`CFG_LLM_WAIT`); 0 gives up at once. */
const waitSecondsOf = (cmd: Command): number => {
  const configured = parseInt(String(cmd.env.CFG_LLM_WAIT ?? ''), 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_WAIT_SECONDS;
};

/** A pause that ends early when the command is stopped. */
const pauseFor = async (cmd: Command, ms: number) => {
  const until = Date.now() + ms;
  while (!cmd.interrupted && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
};

/** The model's answer to `messages`, waited for while the service is away when the caller asks to (`wait`). */
export const chat = async (cmd: Command, messages: LlmMessage[], opts: ChatOptions = {}): Promise<LlmReply> => {
  if (!await mayUseModel(cmd)) throw new Error('sign in to use the language model');
  const waitMs = opts.wait ? waitSecondsOf(cmd) * 1000 : 0;
  let awaySince: number | undefined;
  let awayMs: number | undefined;
  let waiting = false;
  const setWaiting = (away: boolean) => {
    if (away === waiting) return;
    waiting = away;
    opts.onAway?.(away);
  };
  // The wait ends when the service answers, not when its answer has been read.
  const answered = () => {
    if (!waiting) return;
    awayMs = Date.now() - awaySince!;
    setWaiting(false);
  };
  try {
    for (let pause = FIRST_PAUSE_MS;; pause = Math.min(pause * 2, LAST_PAUSE_MS)) {
      try {
        const reply = await request(cmd, messages, opts, answered);
        return awayMs === undefined ? reply : { ...reply, awayMs };
      } catch (error) {
        if (!(error instanceof LlmAwayError) || waitMs <= 0) throw error;
        awaySince ??= Date.now();
        setWaiting(true);
        const left = awaySince + waitMs - Date.now();
        if (left <= 0) throw new LlmUnavailableError(`${error.message}; still away after ${Math.round((Date.now() - awaySince) / 1000)}s`);
        await pauseFor(cmd, Math.min(pause, left));
        if (cmd.interrupted) throw new LlmUnavailableError(`${llmBase(cmd)}: interrupted`);
      }
    }
  } finally {
    setWaiting(false);
  }
};
