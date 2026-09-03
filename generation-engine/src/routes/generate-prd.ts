import { FastifyInstance, FastifyReply } from 'fastify';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { abortOnClientDisconnect } from './client-disconnect';
import { classifyLlmError } from '../llm-errors';
import { LlmCallUsage, normalizeLlmUsage, sumLlmUsage } from '../pipeline/usage';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type StreamPrdEvent = { type: 'chunk'; content: string } | { type: 'usage'; usage: LlmCallUsage };

/** Options threaded to the PRD generation call (task 2a: abort propagation). */
export type StreamPrdOptions = { signal?: AbortSignal };

/**
 * A PRD generation call, abstracted behind an async generator so the route
 * (and its tests) don't depend on a live LLM. The default implementation
 * (`defaultStreamPrd`) is the only thing that talks to `streamText`/AI SDK.
 *
 * The second `options` parameter is how the route propagates a client
 * disconnect: an aborted signal stops token generation mid-stream (no wasted
 * tokens). Test stubs that only take `messages` keep working — the extra
 * parameter is optional.
 */
export type StreamPrdFn = (messages: LlmMessage[], options?: StreamPrdOptions) => AsyncGenerator<StreamPrdEvent>;

/**
 * The engine owns its own LLM provider config (ADR-0031): OPENAI_BASE_URL /
 * OPENAI_API_KEY / AI_MODEL, read fresh per call so a restart isn't needed to
 * pick up a changed env. No BYOK/org routing here — that's a server-side
 * concern the engine has no concept of.
 *
 * AI SDK 6 (task 2a): the abort signal is passed through to `streamText`, and
 * once the stream finishes the final usage is yielded as a `usage` event (the
 * SDK renames usage fields to inputTokens/outputTokens; the wire shape here is
 * normalized by `normalizeLlmUsage`). `.chat(...)` keeps chat-completions
 * semantics for self-hosted OpenAI-compatible gateways (v6's default callable
 * selects the Responses API — see config/provider.ts).
 */
export async function* defaultStreamPrd(messages: LlmMessage[], options?: StreamPrdOptions): AsyncGenerator<StreamPrdEvent> {
  const provider = createOpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const result = streamText({
    model: provider.chat(process.env.AI_MODEL as string),
    messages,
    abortSignal: options?.signal,
  });

  for await (const chunk of result.textStream) {
    yield { type: 'chunk', content: chunk };
  }

  yield { type: 'usage', usage: normalizeLlmUsage(await result.usage) };
}

function writeSSE(reply: FastifyReply, type: string, data: unknown) {
  reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /generate/prd — the one SSE endpoint ticket #91 requires (ADR-0027):
 * PRD generation streamed token-by-token. POST, not GET, since the only
 * client is the ToolJet server (a `fetch` call), never a browser
 * `EventSource` (which requires GET).
 *
 * Wire contract with the server-side proxy (server owns persistence, engine
 * owns none — ADR-0029):
 *  - `chunk`       (repeated): { content: string } — forwarded verbatim
 *  - `engine-done` (once, success only): { usage? } — signals a clean end; the
 *    server maps this onto its own `done` event carrying the persisted
 *    message. Named so it can never collide with the browser-facing `done`
 *    the server emits — the two must never be confused for one another.
 *    `usage` (task 2a, additive) is present when the generator reported token
 *    usage: { promptTokens, completionTokens, totalTokens }.
 *  - `engine-error` (once, failure only): { message: string, aborted?, retryable? } —
 *    mid-stream failure after the response has already started (so it can't be a
 *    non-2xx status any more); the server maps this onto its own `error`.
 *    `aborted: true` (task 2a, additive) marks a client-disconnect abort;
 *    `retryable` (additive) carries the provider-error classification from
 *    llm-errors.ts.
 *
 * A request missing `messages` is rejected with a plain 400 *before* the SSE
 * headers are written, so the server's error path doesn't have to parse an SSE
 * stream to find a validation failure.
 */
export function registerGeneratePrdRoute(app: FastifyInstance, streamPrd: StreamPrdFn) {
  app.post('/generate/prd', async (request, reply) => {
    const body = request.body as { messages?: LlmMessage[] } | undefined;
    const messages = body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      reply.code(400);
      return { error: 'messages is required and must be a non-empty array' };
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    // Stop generating as soon as the client goes away — no wasted tokens.
    const controller = new AbortController();
    abortOnClientDisconnect(reply, controller);

    const usageCalls: LlmCallUsage[] = [];

    try {
      for await (const event of streamPrd(messages, { signal: controller.signal })) {
        if (event.type === 'chunk') {
          writeSSE(reply, 'chunk', { content: event.content });
        } else {
          usageCalls.push(event.usage);
        }
      }
      writeSSE(reply, 'engine-done', usageCalls.length > 0 ? { usage: sumLlmUsage(usageCalls) } : {});
    } catch (error) {
      app.log.error(error);
      const classified = classifyLlmError(error);
      writeSSE(reply, 'engine-error', {
        message: classified?.message ?? (error instanceof Error ? error.message : 'Generation failed'),
        ...(classified?.kind === 'aborted' && { aborted: true }),
        ...(classified && { retryable: classified.retryable }),
      });
    } finally {
      reply.raw.end();
    }
  });
}
