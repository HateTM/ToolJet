import { buildApp } from '../src/app';
import type { StreamPrdFn } from '../src/routes/generate-prd';

/**
 * app.inject() buffers the full response body, so this proves event framing
 * and sequence (SSE wire format, terminal-event contract) — not incrementality.
 * That's covered server-side, on the proxy client, not here.
 */
const AUTH = { authorization: 'Bearer test-engine-key' };

describe('POST /generate/prd', () => {
  beforeAll(() => {
    process.env.ENGINE_API_KEY = 'test-engine-key';
  });

  afterAll(() => {
    delete process.env.ENGINE_API_KEY;
  });

  it('streams chunk events followed by a terminal engine-done event', async () => {
    const streamPrd: StreamPrdFn = async function* () {
      yield { type: 'chunk', content: 'Hello' };
      yield { type: 'chunk', content: ' world' };
    };

    const app = buildApp({ streamPrd });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'build me a CRM' }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toBe(
      'event: chunk\ndata: {"content":"Hello"}\n\n' +
        'event: chunk\ndata: {"content":" world"}\n\n' +
        'event: engine-done\ndata: {}\n\n'
    );

    await app.close();
  });

  it('rejects a request with no messages before starting the stream', async () => {
    const streamPrd: StreamPrdFn = async function* () {
      yield { type: 'chunk', content: 'unreachable' };
    };

    const app = buildApp({ streamPrd });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).not.toContain('text/event-stream');

    await app.close();
  });

  it('emits an engine-error event and ends the stream when generation throws mid-stream', async () => {
    const streamPrd: StreamPrdFn = async function* () {
      yield { type: 'chunk', content: 'partial' };
      throw new Error('upstream LLM blew up');
    };

    const app = buildApp({ streamPrd });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: chunk\ndata: {"content":"partial"}\n\n' +
        'event: engine-error\ndata: {"message":"upstream LLM blew up"}\n\n'
    );

    await app.close();
  });

  // --- Task 2a (AI SDK 6): usage in the terminal event, abort propagation, classification ---

  it('includes token usage in engine-done when the generator reports it (additive field)', async () => {
    const streamPrd: StreamPrdFn = async function* () {
      yield { type: 'chunk', content: 'Hello' };
      yield { type: 'usage', usage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 } };
    };

    const app = buildApp({ streamPrd });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'build me a CRM' }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: chunk\ndata: {"content":"Hello"}\n\n' +
        'event: engine-done\ndata: {"usage":{"promptTokens":20,"completionTokens":7,"totalTokens":27}}\n\n'
    );

    await app.close();
  });

  it('passes an abort signal to the generator and reports an abort without a 500', async () => {
    let receivedSignal: AbortSignal | undefined;
    const streamPrd: StreamPrdFn = async function* (_messages, options) {
      receivedSignal = options?.signal;
      yield { type: 'chunk', content: 'partial' };
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    };

    const app = buildApp({ streamPrd });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.statusCode).toBe(200); // SSE already started — no 500 possible
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(response.body).toBe(
      'event: chunk\ndata: {"content":"partial"}\n\n' +
        'event: engine-error\ndata: {"message":"Generation aborted: the client disconnected.","aborted":true,"retryable":false}\n\n'
    );

    await app.close();
  });

  it('adds retryable classification to engine-error for a retryable provider failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { APICallError } = require('ai');
    const streamPrd: StreamPrdFn = async function* () {
      throw new APICallError({
        message: 'overloaded',
        url: 'https://api.provider.internal/v1/chat?key=sk-secret',
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    };

    const app = buildApp({ streamPrd });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: AUTH,
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.body).toBe(
      'event: engine-error\ndata: {"message":"LLM provider is temporarily unavailable; retry shortly.","retryable":true}\n\n'
    );

    await app.close();
  });
});
