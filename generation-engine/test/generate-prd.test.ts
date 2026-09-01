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
});
