import { FastifyInstance, FastifyReply } from 'fastify';
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type StreamPrdEvent = { type: 'chunk'; content: string };

/**
 * A PRD generation call, abstracted behind an async generator so the route
 * (and its tests) don't depend on a live LLM. The default implementation
 * (`defaultStreamPrd`) is the only thing that talks to `streamText`/AI SDK.
 */
export type StreamPrdFn = (messages: LlmMessage[]) => AsyncGenerator<StreamPrdEvent>;

/**
 * The engine owns its own LLM provider config (ADR-0031): OPENAI_BASE_URL /
 * OPENAI_API_KEY / AI_MODEL, read fresh per call so a restart isn't needed to
 * pick up a changed env. No BYOK/org routing here — that's a server-side
 * concern the engine has no concept of.
 */
export async function* defaultStreamPrd(messages: LlmMessage[]): AsyncGenerator<StreamPrdEvent> {
  const provider = createOpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });

  const result = streamText({
    model: provider(process.env.AI_MODEL as string),
    messages,
  });

  for await (const chunk of result.textStream) {
    yield { type: 'chunk', content: chunk };
  }
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
 *  - `engine-done` (once, success only): {} — signals a clean end; the
 *    server maps this onto its own `done` event carrying the persisted
 *    message. Named so it can never collide with the browser-facing `done`
 *    the server emits — the two must never be confused for one another.
 *  - `engine-error` (once, failure only): { message: string } — mid-stream
 *    failure after the response has already started (so it can't be a
 *    non-2xx status any more); the server maps this onto its own `error`.
 *
 * A request missing `messages` is rejected with a plain 400 *before* the SSE
 * headers are written, so the server's error path doesn't have to parse an
 * SSE stream to find a validation failure.
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

    try {
      for await (const event of streamPrd(messages)) {
        if (event.type === 'chunk') {
          writeSSE(reply, 'chunk', { content: event.content });
        }
      }
      writeSSE(reply, 'engine-done', {});
    } catch (error) {
      app.log.error(error);
      writeSSE(reply, 'engine-error', {
        message: error instanceof Error ? error.message : 'Generation failed',
      });
    } finally {
      reply.raw.end();
    }
  });
}
