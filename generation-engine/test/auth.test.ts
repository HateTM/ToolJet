import { buildApp } from '../src/app';

/**
 * Bearer-token auth on the engine's HTTP endpoints (ticket #114). Uses a stub
 * `streamPrd` so the tests never touch an LLM, and `app.inject()` per the
 * deterministic engine test style (ADR-0034).
 */
const TOKEN = 'test-engine-key';

function stubStreamPrd(): never {
  throw new Error('streamPrd must not be reached when auth rejects');
}

describe('bearer-token auth', () => {
  const ORIGINAL = process.env.ENGINE_API_KEY;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.ENGINE_API_KEY;
    } else {
      process.env.ENGINE_API_KEY = ORIGINAL;
    }
  });

  it('rejects a request without a token (401)', async () => {
    process.env.ENGINE_API_KEY = TOKEN;
    const app = buildApp({ streamPrd: stubStreamPrd });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });

    await app.close();
  });

  it('rejects a request with a wrong token (401)', async () => {
    process.env.ENGINE_API_KEY = TOKEN;
    const app = buildApp({ streamPrd: stubStreamPrd });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: { authorization: 'Bearer wrong-token' },
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });

  it('accepts a request with the correct token', async () => {
    process.env.ENGINE_API_KEY = TOKEN;
    const streamPrd = async function* () {
      yield { type: 'chunk', content: 'ok' };
    };
    const app = buildApp({ streamPrd });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: engine-done');

    await app.close();
  });

  it('fails closed when ENGINE_API_KEY is unset (503, not silent allow)', async () => {
    delete process.env.ENGINE_API_KEY;
    const app = buildApp({ streamPrd: stubStreamPrd });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/prd',
      headers: { authorization: 'Bearer anything' },
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain('ENGINE_API_KEY');

    await app.close();
  });

  it('keeps /health unauthenticated for container healthchecks', async () => {
    delete process.env.ENGINE_API_KEY;
    const app = buildApp({ streamPrd: stubStreamPrd });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
