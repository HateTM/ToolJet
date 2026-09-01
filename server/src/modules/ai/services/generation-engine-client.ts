import { Injectable, Logger } from '@nestjs/common';
import { parseEngineSSE } from './engine-sse-parser';

export type EngineMessage = { role: string; content: string };

export type GenerationEngineEvent =
  | { type: 'chunk'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Idle-timeout: no event from the engine (not even a chunk) within this window
 * aborts the request. Guards against "engine accepts the connection then goes
 * silent" (AC#3) — a plain connect timeout wouldn't catch that, since the
 * connection did succeed.
 */
const IDLE_TIMEOUT_MS = 60_000;

/**
 * Server-side proxy client for the Generation engine's `POST /generate/prd`
 * SSE endpoint (ADR-0027). Talks HTTP+SSE to the engine (ADR-0029: stateless,
 * no shared process/DB), translates the engine's wire events
 * (`chunk`/`engine-done`/`engine-error`, generation-engine/src/routes/generate-prd.ts)
 * into a small caller-facing union that never collides with the browser-facing
 * `done`/`error` AiService.sendUserMessage already emits — the caller (AiService)
 * owns persisting the accumulated text and emitting its own `done`.
 *
 * `GENERATION_ENGINE_URL` unset means the engine isn't deployed yet (ADR-0032,
 * CONTEXT.md: "not wired into the root build chain") — callers check
 * `GenerationEngineClient.isConfigured()` and fall back to the in-process
 * `AIGateway` path rather than fail every PRD generation the moment this ships.
 */
@Injectable()
export class GenerationEngineClient {
  private readonly logger = new Logger(GenerationEngineClient.name);

  isConfigured(): boolean {
    return Boolean(process.env.GENERATION_ENGINE_URL);
  }

  /**
   * Opens the SSE connection and yields translated events as they arrive —
   * no buffering, per ADR-0027/AC#2. `signal` lets the caller abort the
   * upstream request when the browser disconnects.
   */
  async *streamPrd(messages: EngineMessage[], signal?: AbortSignal): AsyncGenerator<GenerationEngineEvent> {
    const baseUrl = process.env.GENERATION_ENGINE_URL;
    if (!baseUrl) {
      throw new Error('GenerationEngineClient: GENERATION_ENGINE_URL is not configured');
    }

    const idleController = new AbortController();
    const idleTimer = setTimeout(() => idleController.abort(), IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
    const onExternalAbort = () => idleController.abort();
    signal?.addEventListener('abort', onExternalAbort);

    const resetIdleTimer = () => {
      idleTimer.refresh();
    };

    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/generate/prd`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Shared secret required by the engine's auth middleware (ticket
          // #114, ADR-0032). Same env var the engine checks; unset here means
          // the engine rejects with 401/503 — surfaced as an engine error.
          ...(process.env.ENGINE_API_KEY && { Authorization: `Bearer ${process.env.ENGINE_API_KEY}` }),
        },
        body: JSON.stringify({ messages }),
        signal: idleController.signal,
      });
    } catch (error: any) {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onExternalAbort);
      throw new Error(`GenerationEngineClient: engine unreachable (${error?.message || error})`);
    }

    if (!response.ok || !response.body) {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onExternalAbort);
      throw new Error(`GenerationEngineClient: engine responded ${response.status}`);
    }

    let sawTerminalEvent = false;

    try {
      for await (const event of parseEngineSSE(iterateWebStream(response.body))) {
        resetIdleTimer();

        if (event.type === 'chunk') {
          const content = (event.data as { content?: string })?.content;
          if (typeof content === 'string') {
            yield { type: 'chunk', content };
          }
          continue;
        }

        if (event.type === 'engine-done') {
          sawTerminalEvent = true;
          yield { type: 'done' };
          return;
        }

        if (event.type === 'engine-error') {
          sawTerminalEvent = true;
          const message = (event.data as { message?: string })?.message || 'Generation engine reported an error';
          yield { type: 'error', message };
          return;
        }
        // Unrecognized event types (e.g. a future engine addition) are ignored
        // rather than surfaced — this proxy only knows the ADR-0027 contract.
      }
    } catch (error: any) {
      // Includes the idle-timeout abort: fetch/undici surface that as an
      // AbortError on the body reader, not as a rejected fetch() call.
      this.logger.error(`[GenerationEngineClient] stream read failed: ${error?.message}`, error?.stack);
      yield { type: 'error', message: 'Generation engine connection was lost' };
      return;
    } finally {
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    // Stream ended with neither engine-done nor engine-error: per AC#3, silence
    // must not be mistaken for success — a truncated message must not be
    // persisted and reported as `done`.
    if (!sawTerminalEvent) {
      yield { type: 'error', message: 'Generation engine stream ended unexpectedly' };
    }
  }
}

async function* iterateWebStream(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
