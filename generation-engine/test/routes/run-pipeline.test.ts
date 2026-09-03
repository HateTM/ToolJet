import { buildApp } from '../../src/app';
import { PipelineDepsFactory } from '../../src/routes/run-pipeline';
import { DefaultPipelineDeps } from '../../src/pipeline';

/**
 * A deps factory whose LLM halves are fakes: deterministic, no network. The
 * shapes returned mirror what the real llm-deps.ts halves produce after their
 * deterministic parse/validate halves run.
 */
function fakeDepsFactory(emitLog: string[]): PipelineDepsFactory {
  return (emit) => {
    const deps: DefaultPipelineDeps = {
      classify: {
        async classify() {
          return { intent: 'build_app', confidence: 0.9 };
        },
      },
      prd: {
        async generatePrd() {
          emit('prd-chunk', { content: 'PRD ' });
          emit('prd-chunk', { content: 'text' });
          return 'PRD text';
        },
      },
      lld: {
        async generateLld() {
          return {
            tables: [
              {
                table_name: 'customers',
                columns: [
                  {
                    column_name: 'id',
                    data_type: 'integer',
                    constraints_type: { is_primary_key: true },
                  },
                ],
              },
            ],
          };
        },
      },
      stepPlan: {
        async generateStepPlan() {
          return { steps: [{ type: 'CreateTable', description: 'create customers' }] };
        },
      },
      stepGeneration: {
        async generateStepPayload() {
          return {};
        },
      },
      evaluate: {
        async judge() {
          return { pass: true, reasons: [] };
        },
      },
    };
    emitLog.push('factory-called');
    return deps;
  };
}

function parseSSE(payload: string): Array<{ event: string; data: any }> {
  return payload
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event = '';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
      }
      return { event, data: dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined };
    });
}

const VALID_BODY = {
  prompt: 'Build a CRM app',
  organizationId: 'org-1',
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
};

beforeAll(() => {
  process.env.ENGINE_API_KEY = 'test-key';
});

afterAll(() => {
  delete process.env.ENGINE_API_KEY;
});

describe('POST /generate/run', () => {
  it('streams prd-chunk and stage progress, then engine-done with the full artifact payload', async () => {
    const emitLog: string[] = [];
    const app = buildApp({ pipelineDepsFactory: fakeDepsFactory(emitLog) });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const events = parseSSE(response.payload);
    const types = events.map((e) => e.event);

    // PRD deltas streamed as produced, before the terminal event.
    const prdChunks = events.filter((e) => e.event === 'prd-chunk');
    expect(prdChunks.map((e) => e.data.content).join('')).toBe('PRD text');

    // Every stage that ran announced itself first — the full 8-stage
    // ADR-0028/ADR-0048 sequence (feature-planner and per-entity run on their
    // deterministic defaults).
    expect(types.filter((t) => t === 'stage')).toHaveLength(8);
    const stageNames = events.filter((e) => e.event === 'stage').map((e) => e.data.stage);
    expect(stageNames).toEqual([
      'classify',
      'prd',
      'lld',
      'feature-planner',
      'per-entity',
      'step-plan',
      'step-generation',
      'evaluate',
    ]);

    // Terminal event carries all final artifacts in one structured payload.
    const done = events.find((e) => e.event === 'engine-done');
    expect(done).toBeDefined();
    expect(done.data.artifacts).toMatchObject({
      prompt: 'Build a CRM app',
      classification: { intent: 'build_app', confidence: 0.9 },
      prd: 'PRD text',
      lld: { tables: [{ table_name: 'customers' }] },
      featurePlan: { items: [{ entityName: 'customers', dependsOn: [] }] },
      entityToolCalls: [{ entityName: 'customers', action: 'create', toolName: 'create_table' }],
      stepPlan: { steps: [{ type: 'CreateTable' }] },
      evaluation: { pass: true, reasons: [] },
    });

    // Terminal event is last.
    expect(types[types.length - 1]).toBe('engine-done');

    app.close();
  });

  it('rejects a request without a prompt or llm config with a 400 before any SSE is written', async () => {
    const app = buildApp({ pipelineDepsFactory: fakeDepsFactory([]) });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: { llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).not.toContain('text/event-stream');
    expect(JSON.parse(response.payload).error).toContain('prompt');

    const missingModel = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: { prompt: 'x', llm: { provider: 'openai', apiKey: 'sk-test' } },
    });
    expect(missingModel.statusCode).toBe(400);

    app.close();
  });

  it('surfaces a failing stage as engine-error naming the stage', async () => {
    const app = buildApp({
      pipelineDepsFactory: () => ({
        classify: {
          async classify() {
            return { intent: 'build_app', confidence: 0.9 };
          },
        },
        prd: {
          async generatePrd() {
            throw new Error('LLM provider exploded');
          },
        },
        lld: {
          async generateLld() {
            throw new Error('should not run');
          },
        },
        stepPlan: {
          async generateStepPlan() {
            throw new Error('should not run');
          },
        },
        stepGeneration: {
          async generateStepPayload() {
            throw new Error('should not run');
          },
        },
        evaluate: {
          async judge() {
            throw new Error('should not run');
          },
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    const events = parseSSE(response.payload);
    const error = events.find((e) => e.event === 'engine-error');
    expect(error).toBeDefined();
    expect(error.data.message).toContain('prd');
    expect(error.data.message).toContain('LLM provider exploded');
    expect(error.data.stage).toBe('prd');
    expect(events.map((e) => e.event)).not.toContain('engine-done');

    app.close();
  });

  it('returns an unsupported classification as a normal engine-done with short-circuited artifacts', async () => {
    const app = buildApp({
      pipelineDepsFactory: () => ({
        classify: {
          async classify() {
            return { intent: 'unsupported', confidence: 0.5 };
          },
        },
        prd: {
          async generatePrd() {
            throw new Error('must be short-circuited');
          },
        },
        lld: {
          async generateLld() {
            throw new Error('must be short-circuited');
          },
        },
        stepPlan: {
          async generateStepPlan() {
            throw new Error('must be short-circuited');
          },
        },
        stepGeneration: {
          async generateStepPayload() {
            throw new Error('must be short-circuited');
          },
        },
        evaluate: {
          async judge() {
            throw new Error('must be short-circuited');
          },
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    const events = parseSSE(response.payload);
    const done = events.find((e) => e.event === 'engine-done');
    expect(done).toBeDefined();
    expect(done.data.artifacts.classification).toEqual({ intent: 'unsupported', confidence: 0 });
    expect(done.data.artifacts.prd).toBeUndefined();
    expect(events.map((e) => e.event)).not.toContain('prd-chunk');

    app.close();
  });

  it('requires the engine API key (auth middleware covers the route)', async () => {
    const app = buildApp({ pipelineDepsFactory: fakeDepsFactory([]) });

    const noHeader = await app.inject({ method: 'POST', url: '/generate/run', payload: VALID_BODY });
    expect(noHeader.statusCode).toBe(401);

    const wrongHeader = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer nope' },
      payload: VALID_BODY,
    });
    expect(wrongHeader.statusCode).toBe(401);

    app.close();
  });

  // --- Task 2a (AI SDK 6): per-call usage events, terminal usage, abort, classification ---

  it('emits a usage event per LLM call and cumulative usage on engine-done', async () => {
    const app = buildApp({
      pipelineDepsFactory: (emit) => ({
        classify: {
          async classify(_prompt: string, ctx: { usage?: { record(u: unknown): void } }) {
            ctx.usage?.record({ promptTokens: 100, completionTokens: 10, totalTokens: 110 });
            return { intent: 'build_app', confidence: 0.9 };
          },
        },
        prd: {
          async generatePrd(_input: string, ctx: { usage?: { record(u: unknown): void } }) {
            emit('prd-chunk', { content: 'PRD text' });
            ctx.usage?.record({ promptTokens: 50, completionTokens: 5, totalTokens: 55 });
            return 'PRD text';
          },
        },
        lld: {
          async generateLld(_prd: string, ctx: { usage?: { record(u: unknown): void } }) {
            ctx.usage?.record({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
            return {
              tables: [
                {
                  table_name: 'customers',
                  columns: [{ column_name: 'id', data_type: 'integer', constraints_type: { is_primary_key: true } }],
                },
              ],
            };
          },
        },
        stepPlan: { async generateStepPlan() { return { steps: [{ type: 'CreateTable', description: 't' }] }; } },
        stepGeneration: { async generateStepPayload() { return {}; } },
        evaluate: { async judge() { return { pass: true, reasons: [] }; } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    const events = parseSSE(response.payload);

    // One usage event per LLM call, in call order.
    const usageEvents = events.filter((e) => e.event === 'usage');
    expect(usageEvents.map((e) => e.data)).toEqual([
      { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
      { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
      { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
    ]);

    // Terminal event carries the cumulative total additively.
    const done = events.find((e) => e.event === 'engine-done');
    expect(done.data.usage).toEqual({ promptTokens: 160, completionTokens: 16, totalTokens: 176 });
    expect(done.data.artifacts.evaluation).toEqual({ pass: true, reasons: [] });

    app.close();
  });

  it('omits the usage field on engine-done when no LLM call reported usage', async () => {
    const app = buildApp({ pipelineDepsFactory: fakeDepsFactory([]) });
    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });
    const done = parseSSE(response.payload).find((e) => e.event === 'engine-done');
    expect(done.data.usage).toBeUndefined();
    app.close();
  });

  it('classifies a retryable provider failure on engine-error (additive kind/retryable fields)', async () => {
    const { APICallError } = require('ai');
    const app = buildApp({
      pipelineDepsFactory: () => ({
        classify: {
          async classify() {
            throw new APICallError({
              message: 'overloaded',
              url: 'https://api.provider.internal/v1/chat?key=sk-secret',
              requestBodyValues: {},
              statusCode: 429,
              isRetryable: true,
            });
          },
        },
        prd: { async generatePrd() { throw new Error('should not run'); } },
        lld: { async generateLld() { throw new Error('should not run'); } },
        stepPlan: { async generateStepPlan() { throw new Error('should not run'); } },
        stepGeneration: { async generateStepPayload() { throw new Error('should not run'); } },
        evaluate: { async judge() { throw new Error('should not run'); } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    const events = parseSSE(response.payload);
    const error = events.find((e) => e.event === 'engine-error');
    expect(error).toBeDefined();
    expect(error.data.kind).toBe('provider_unavailable');
    expect(error.data.retryable).toBe(true);
    expect(error.data.stage).toBe('classify');
    expect(error.data.message).not.toContain('api.provider.internal');
    expect(error.data.message).not.toContain('sk-secret');
    app.close();
  });

  it('threads an abort signal through StageContext (client disconnect stops generation)', async () => {
    let captured: AbortSignal | undefined;
    const app = buildApp({
      pipelineDepsFactory: () => ({
        classify: {
          async classify(_prompt: string, ctx: { signal?: AbortSignal }) {
            captured = ctx.signal;
            return { intent: 'build_app', confidence: 0.9 };
          },
        },
        prd: {
          async generatePrd() {
            return 'PRD text';
          },
        },
        lld: {
          async generateLld() {
            return {
              tables: [
                {
                  table_name: 'customers',
                  columns: [{ column_name: 'id', data_type: 'integer', constraints_type: { is_primary_key: true } }],
                },
              ],
            };
          },
        },
        stepPlan: {
          async generateStepPlan() {
            return { steps: [{ type: 'CreateTable', description: 'create customers' }] };
          },
        },
        stepGeneration: { async generateStepPayload() { return {}; } },
        evaluate: { async judge() { return { pass: true, reasons: [] }; } },
      }),
    });

    await app.inject({
      method: 'POST',
      url: '/generate/run',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(captured).toBeInstanceOf(AbortSignal);
    app.close();
  });
});
