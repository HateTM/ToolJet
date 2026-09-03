import { buildApp } from '../../src/app';
import { GenerateStepsDepsFactory } from '../../src/routes/generate-steps';
import { DefaultPipelineDeps } from '../../src/pipeline';

const VALID_BODY = {
  prd: '# PRD\n\nA CRM with a customers table.',
  organizationId: 'org-1',
  llm: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
};

function fakeDepsFactory(log: string[]): GenerateStepsDepsFactory {
  return () => {
    const deps: DefaultPipelineDeps = {
      lld: {
        async generateLld() {
          log.push('lld');
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
          return {
            steps: [
              { type: 'CreateTable', description: 'create customers' },
              { type: 'UpdateComponent', description: 'retitle the heading' },
            ],
          };
        },
      },
      stepGeneration: {
        async generateStepPayload() {
          return { componentId: 'comp-1', properties: { text: 'Hello' } };
        },
      },
      evaluate: {
        async judge() {
          return { pass: true, reasons: [] };
        },
      },
    };
    return deps;
  };
}

beforeAll(() => {
  process.env.ENGINE_API_KEY = 'test-key';
});

afterAll(() => {
  delete process.env.ENGINE_API_KEY;
});

describe('POST /generate/steps', () => {
  it('runs the approved-PRD pipeline and returns stepPlan plus generatedSteps as JSON', async () => {
    const log: string[] = [];
    const app = buildApp({ generateStepsDepsFactory: fakeDepsFactory(log) });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const { artifacts } = JSON.parse(response.payload);
    expect(artifacts.prd).toBe(VALID_BODY.prd);
    expect(artifacts.classification).toBeUndefined(); // classify never runs on this route
    expect(artifacts.lld?.tables).toHaveLength(1);
    expect(artifacts.stepPlan.steps).toHaveLength(2);
    expect(artifacts.generatedSteps).toEqual([
      { index: 1, type: 'UpdateComponent', payload: { componentId: 'comp-1', properties: { text: 'Hello' } } },
    ]);
    expect(artifacts.evaluation).toEqual({ pass: true, reasons: [] });
    app.close();
  });

  it('skips the lld stage when the caller supplies one', async () => {
    const log: string[] = [];
    const app = buildApp({ generateStepsDepsFactory: fakeDepsFactory(log) });
    const lld = {
      tables: [
        { table_name: 'users', columns: [{ column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } }] },
      ],
    };

    const response = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: { ...VALID_BODY, lld },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).artifacts.lld).toEqual(lld);
    expect(log).not.toContain('lld');
    app.close();
  });

  it('rejects a request without a prd or a usable llm config with a plain 400', async () => {
    const app = buildApp({ generateStepsDepsFactory: fakeDepsFactory([]) });

    const noPrd = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: { llm: VALID_BODY.llm },
    });
    expect(noPrd.statusCode).toBe(400);
    expect(JSON.parse(noPrd.payload).error).toContain('prd');

    const missingModel = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: { prd: 'x', llm: { provider: 'openai', apiKey: 'sk-test' } },
    });
    expect(missingModel.statusCode).toBe(400);
    app.close();
  });

  it('surfaces a failing stage as a 500 naming the stage', async () => {
    const app = buildApp({
      generateStepsDepsFactory: () => ({
        lld: {
          async generateLld() {
            throw new Error('LLM provider exploded');
          },
        },
        stepPlan: { async generateStepPlan() { throw new Error('should not run'); } },
        stepGeneration: { async generateStepPayload() { throw new Error('should not run'); } },
        evaluate: { async judge() { throw new Error('should not run'); } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.payload);
    expect(body.error).toContain('LLM provider exploded');
    expect(body.stage).toBe('lld');
    app.close();
  });

  it('requires the engine API key (auth middleware covers the route)', async () => {
    const app = buildApp({ generateStepsDepsFactory: fakeDepsFactory([]) });

    const noHeader = await app.inject({ method: 'POST', url: '/generate/steps', payload: VALID_BODY });
    expect(noHeader.statusCode).toBe(401);
    app.close();
  });

  // --- Task 2a (AI SDK 6): usage, abort propagation, provider error classification ---

  it('maps a retryable provider failure (APICallError 500/429) to a 503 with a sanitized message', async () => {
    const { APICallError } = require('ai');
    const app = buildApp({
      generateStepsDepsFactory: () => ({
        lld: {
          async generateLld() {
            throw new APICallError({
              message: 'internal error',
              url: 'https://api.provider.internal/v1/chat?key=sk-secret',
              requestBodyValues: {},
              statusCode: 500,
              isRetryable: true,
            });
          },
        },
        stepPlan: { async generateStepPlan() { throw new Error('should not run'); } },
        stepGeneration: { async generateStepPayload() { throw new Error('should not run'); } },
        evaluate: { async judge() { throw new Error('should not run'); } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.payload);
    expect(body.kind).toBe('provider_unavailable');
    expect(body.retryable).toBe(true);
    expect(body.error).not.toContain('api.provider.internal');
    expect(body.error).not.toContain('sk-secret');
    expect(body.stage).toBe('lld');
    app.close();
  });

  it('maps an invalid-request provider failure (APICallError 4xx) to a 400', async () => {
    const { APICallError } = require('ai');
    const app = buildApp({
      generateStepsDepsFactory: () => ({
        lld: {
          async generateLld() {
            throw new APICallError({
              message: 'bad model name',
              url: 'https://api.provider.internal/v1/chat',
              requestBodyValues: {},
              statusCode: 404,
              isRetryable: false,
            });
          },
        },
        stepPlan: { async generateStepPlan() { throw new Error('should not run'); } },
        stepGeneration: { async generateStepPayload() { throw new Error('should not run'); } },
        evaluate: { async judge() { throw new Error('should not run'); } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.kind).toBe('invalid_request');
    expect(body.retryable).toBe(false);
    expect(body.stage).toBe('lld');
    app.close();
  });

  it('includes cumulative token usage as an additive response field', async () => {
    const app = buildApp({
      generateStepsDepsFactory: () => ({
        lld: {
          async generateLld(_prd: string, ctx: { usage?: { record(u: unknown): void } }) {
            ctx.usage?.record({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
            ctx.usage?.record({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
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
          async generateStepPlan(_input: string, ctx: { usage?: { record(u: unknown): void } }) {
            ctx.usage?.record({ promptTokens: 50, completionTokens: 5, totalTokens: 55 });
            return { steps: [{ type: 'CreateTable', description: 'create customers' }] };
          },
        },
        stepGeneration: { async generateStepPayload() { return {}; } },
        evaluate: { async judge() { return { pass: true, reasons: [] }; } },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.usage).toEqual({ promptTokens: 160, completionTokens: 27, totalTokens: 187 });
    expect(body.artifacts.evaluation).toEqual({ pass: true, reasons: [] });
    app.close();
  });

  it('threads an abort signal through StageContext so LLM halves can be interrupted', async () => {
    let captured: AbortSignal | undefined;
    const app = buildApp({
      generateStepsDepsFactory: () => ({
        lld: {
          async generateLld(_prd: string, ctx: { signal?: AbortSignal }) {
            captured = ctx.signal;
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
      url: '/generate/steps',
      headers: { authorization: 'Bearer test-key' },
      payload: VALID_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(captured).toBeInstanceOf(AbortSignal);
    // The hijacked response's close fires after the run ends — which is exactly
    // what aborts the signal, proving the disconnect wiring is live.
    expect(captured!.aborted).toBe(true);
    app.close();
  });
});
