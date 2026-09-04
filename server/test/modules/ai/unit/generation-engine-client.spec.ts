// server/test/modules/ai/unit/generation-engine-client.spec.ts

import { GenerationEngineClient } from 'src/modules/ai/services/generation-engine-client';

function sseBody(chunks: string[]): { body: ReadableStream<Uint8Array>; push: (chunk: string) => void } {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return {
    body,
    push: (chunk: string) => controllerRef.enqueue(encoder.encode(chunk)),
  };
}

describe('GenerationEngineClient', () => {
  const originalEnv = process.env.GENERATION_ENGINE_URL;
  const originalFetch = global.fetch;

  afterEach(() => {
    process.env.GENERATION_ENGINE_URL = originalEnv;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('reports not configured when GENERATION_ENGINE_URL is unset', () => {
    delete process.env.GENERATION_ENGINE_URL;
    const client = new GenerationEngineClient();

    expect(client.isConfigured()).toBe(false);
  });

  it('reports configured when GENERATION_ENGINE_URL is set', () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    const client = new GenerationEngineClient();

    expect(client.isConfigured()).toBe(true);
  });

  it('translates chunk + engine-done (no usage) into chunk events followed by a bare done', async () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    const { body } = sseBody([
      'event: chunk\ndata: {"content":"Hello"}\n\n',
      'event: chunk\ndata: {"content":" world"}\n\n',
      'event: engine-done\ndata: {}\n\n',
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body }) as any;

    const client = new GenerationEngineClient();
    const events = [];
    for await (const event of client.streamPrd([{ role: 'user', content: 'x' }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'chunk', content: 'Hello' },
      { type: 'chunk', content: ' world' },
      { type: 'done', usage: undefined },
    ]);
  });

  it('translates engine-done usage into the done event (ADR-0052 follow-up)', async () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    const { body } = sseBody([
      'event: chunk\ndata: {"content":"Hi"}\n\n',
      'event: engine-done\ndata: {"usage":{"promptTokens":12,"completionTokens":8,"totalTokens":20}}\n\n',
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body }) as any;

    const client = new GenerationEngineClient();
    const events = [];
    for await (const event of client.streamPrd([{ role: 'user', content: 'x' }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'chunk', content: 'Hi' },
      { type: 'done', usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 } },
    ]);
  });

  it('forwards chunks incrementally rather than buffering the full stream (AC#2)', async () => {
    // A manually-driven stream: nothing is enqueued until the test pulls a chunk out of the
    // generator, which is only possible if the client is not waiting on the whole body first.
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
    });
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body }) as any;

    const client = new GenerationEngineClient();
    const iterator = client.streamPrd([{ role: 'user', content: 'x' }])[Symbol.asyncIterator]();

    controllerRef!.enqueue(encoder.encode('event: chunk\ndata: {"content":"first"}\n\n'));
    const first = await iterator.next();
    expect(first.value).toEqual({ type: 'chunk', content: 'first' });

    controllerRef!.enqueue(encoder.encode('event: chunk\ndata: {"content":"second"}\n\n'));
    const second = await iterator.next();
    expect(second.value).toEqual({ type: 'chunk', content: 'second' });

    controllerRef!.enqueue(encoder.encode('event: engine-done\ndata: {}\n\n'));
    controllerRef!.close();
    const third = await iterator.next();
    expect(third.value).toEqual({ type: 'done', usage: undefined });
  });

  it('translates engine-error into an error event', async () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    const { body } = sseBody([
      'event: chunk\ndata: {"content":"partial"}\n\n',
      'event: engine-error\ndata: {"message":"LLM blew up"}\n\n',
    ]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body }) as any;

    const client = new GenerationEngineClient();
    const events = [];
    for await (const event of client.streamPrd([{ role: 'user', content: 'x' }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'chunk', content: 'partial' },
      { type: 'error', message: 'LLM blew up' },
    ]);
  });

  it('yields an error when the engine is unreachable', async () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;

    const client = new GenerationEngineClient();

    await expect(client.streamPrd([{ role: 'user', content: 'x' }]).next()).rejects.toThrow(/engine unreachable/);
  });

  it('yields an error when the stream ends with no terminal event (silent truncation)', async () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    const { body } = sseBody(['event: chunk\ndata: {"content":"partial"}\n\n']);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, body }) as any;

    const client = new GenerationEngineClient();
    const events = [];
    for await (const event of client.streamPrd([{ role: 'user', content: 'x' }])) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'chunk', content: 'partial' },
      { type: 'error', message: 'Generation engine stream ended unexpectedly' },
    ]);
  });

  it('yields an error when the engine responds with a non-2xx status', async () => {
    process.env.GENERATION_ENGINE_URL = 'http://generation-engine:3100';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, body: null }) as any;

    const client = new GenerationEngineClient();

    await expect(client.streamPrd([{ role: 'user', content: 'x' }]).next()).rejects.toThrow(/responded 500/);
  });
});
