import { GenerationEnginePipelineClient } from '@modules/ai/services/generation-engine-pipeline-client';

/**
 * Collects an async generator into an array.
 */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

/**
 * Builds a ReadableStream<Uint8Array> from SSE text, chunked at the given
 * byte boundaries (default: one chunk per piece) so parser buffering across
 * chunk boundaries is exercised too.
 */
function sseStream(pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < pieces.length) {
        controller.enqueue(encoder.encode(pieces[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

const VALID_LLM = { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' };

describe('GenerationEnginePipelineClient', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env.GENERATION_ENGINE_URL = 'http://engine:3100/';
    process.env.ENGINE_API_KEY = 'engine-secret';
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  it('isConfigured is false without GENERATION_ENGINE_URL (ADR-0036 flag guard)', () => {
    delete process.env.GENERATION_ENGINE_URL;
    const client = new GenerationEnginePipelineClient();
    expect(client.isConfigured()).toBe(false);
  });

  it('runPipeline throws without GENERATION_ENGINE_URL', async () => {
    delete process.env.GENERATION_ENGINE_URL;
    const client = new GenerationEnginePipelineClient();
    await expect(collect(client.runPipeline('p', VALID_LLM, 'org-1'))).rejects.toThrow(
      /GENERATION_ENGINE_URL is not configured/
    );
  });

  it('mirrors the engine stream into the caller-facing union, preserving order', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: sseStream([
        'event: stage\ndata: {"stage":"classify"}\n\n',
        // Deliberately split across chunk boundaries to exercise the parser.
        'event: prd-chunk\nda',
        'ta: {"content":"PRD "}\n\nevent: prd-chunk\ndata: {"content":"text"}\n\n',
        ': keepalive\n\n',
        'event: engine-done\ndata: {"artifacts":{"classification":{"intent":"build_app"},"stepPlan":{"steps":[]}}}\n\n',
      ]),
    });
    global.fetch = fetchMock as any;

    const client = new GenerationEnginePipelineClient();
    const events = await collect(client.runPipeline('Build a CRM', VALID_LLM, 'org-1'));

    expect(events).toEqual([
      { type: 'stage', stage: 'classify' },
      { type: 'prd-chunk', content: 'PRD ' },
      { type: 'prd-chunk', content: 'text' },
      {
        type: 'done',
        artifacts: { classification: { intent: 'build_app' }, stepPlan: { steps: [] } },
      },
    ]);

    // Request shape posted to the engine: route, shared secret, per-request llm.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://engine:3100/generate/run');
    expect(init.headers.Authorization).toBe('Bearer engine-secret');
    expect(JSON.parse(init.body)).toEqual({
      prompt: 'Build a CRM',
      organizationId: 'org-1',
      llm: VALID_LLM,
    });
  });

  it('maps engine-error onto a translated error event, no done', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: sseStream([
        'event: stage\ndata: {"stage":"prd"}\n\n',
        'event: engine-error\ndata: {"message":"LLM provider exploded","stage":"prd"}\n\n',
      ]),
    }) as any;

    const client = new GenerationEnginePipelineClient();
    const events = await collect(client.runPipeline('p', VALID_LLM, 'org-1'));

    expect(events).toEqual([
      { type: 'stage', stage: 'prd' },
      { type: 'error', message: 'LLM provider exploded', stage: 'prd' },
    ]);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('treats a stream ending without a terminal event as an error, not success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: sseStream(['event: prd-chunk\ndata: {"content":"half a PRD"}\n\n']),
    }) as any;

    const client = new GenerationEnginePipelineClient();
    const events = await collect(client.runPipeline('p', VALID_LLM, 'org-1'));

    expect(events).toEqual([
      { type: 'prd-chunk', content: 'half a PRD' },
      { type: 'error', message: 'Generation engine stream ended unexpectedly' },
    ]);
  });

  it('throws on a non-2xx engine response (e.g. auth failure) before streaming', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, body: null }) as any;

    const client = new GenerationEnginePipelineClient();
    await expect(collect(client.runPipeline('p', VALID_LLM, 'org-1'))).rejects.toThrow(/engine responded 401/);
  });
});
