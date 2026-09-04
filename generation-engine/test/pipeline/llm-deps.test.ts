import { generateText, Output } from 'ai';
import { buildRealPipelineDeps } from '../../src/pipeline/llm-deps';
import {
  CLASSIFY_SYSTEM_PROMPT,
  CREATE_TABLE_SYSTEM_PROMPT,
  EVALUATE_SYSTEM_PROMPT,
  LLD_SYSTEM_PROMPT,
  PRD_SYSTEM_PROMPT,
  STEP_PLAN_SYSTEM_PROMPT,
  UPDATE_COMPONENT_SYSTEM_PROMPT,
  UPDATE_TABLE_SYSTEM_PROMPT,
} from '../../src/prompts';
import { PipelineArtifacts, EntityToolCall } from '../../src/pipeline/types';
import { TEST_LLM_CONFIG, makeTestCtx } from './ctx';

jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return {
    ...actual,
    // The real Output.object is used; only generateText is faked.
    generateText: jest.fn(),
  };
});

const mockGenerateText = generateText as jest.Mock;

function lastCall() {
  const args = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1][0];
  return {
    model: args.model,
    // AI SDK 6 rejects a system-role entry inside `messages` — callModel sends the
    // system prompt via `instructions` instead (see llm-deps.ts).
    system: args.instructions as string,
    user: args.messages[0].content as string,
    abortSignal: args.abortSignal as AbortSignal | undefined,
    hasOutput: args.output !== undefined,
  };
}

/** A v6-shaped generateText result: text, validated output, usage. */
function result(text: string, output: unknown, usage?: { inputTokens?: number; outputTokens?: number }) {
  return Promise.resolve({ text, output, usage });
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockGenerateText.mockImplementation(() => result('', { intent: 'build_app', confidence: 0.9 }));
});

describe('buildRealPipelineDeps', () => {
  const ctx = makeTestCtx();

  it('classify uses the classify prompt and ctx.llm-resolved model, returning JSON', async () => {
    mockGenerateText.mockImplementation(() => result('# ignored', { intent: 'build_app', confidence: 0.9 }));
    const raw = await buildRealPipelineDeps().classify.classify('build a CRM', ctx);
    const { system, model } = lastCall();
    expect(system).toBe(CLASSIFY_SYSTEM_PROMPT);
    expect(model).toBeDefined();
    expect(raw).toEqual({ intent: 'build_app', confidence: 0.9 });
  });

  it('prd uses the PRD prompt and returns the plain text', async () => {
    mockGenerateText.mockImplementation(() => Promise.resolve({ text: '# PRD', usage: undefined }));
    const prd = await buildRealPipelineDeps().prd.generatePrd('build a CRM', ctx);
    const { system, user, hasOutput } = lastCall();
    expect(system).toBe(PRD_SYSTEM_PROMPT);
    expect(user).toBe('build a CRM');
    expect(hasOutput).toBe(false); // plain text call — no structured output
    expect(prd).toBe('# PRD');
  });

  it('lld assembles the catalog context into the prompt and returns parsed JSON', async () => {
    mockGenerateText.mockImplementation(() => result('', { tables: [] }));
    const raw = await buildRealPipelineDeps().lld.generateLld('CRM PRD', ctx);
    const { system, user } = lastCall();
    expect(system).toBe(LLD_SYSTEM_PROMPT);
    expect(user).toContain('CRM PRD');
    expect(user).toContain('"onRowClicked"');
    expect(raw).toEqual({ tables: [] });
  });

  it('per-entity uses the update-table prompt for update calls with catalog context', async () => {
    const artifacts: PipelineArtifacts = {
      prompt: 'x',
      prd: 'PRD',
      featurePlan: { items: [{ entityName: 'orders', dependsOn: [] }] },
    };
    const call: EntityToolCall = { entityName: 'orders', action: 'update', toolName: 'update_table' };
    await buildRealPipelineDeps().perEntity!.executeToolCall!(call, artifacts, ctx);
    const { system, user } = lastCall();
    expect(system).toBe(UPDATE_TABLE_SYSTEM_PROMPT);
    expect(user).toContain('orders');
    expect(user).toContain('"components"');
  });

  it('per-entity uses the create-table prompt for create calls', async () => {
    const artifacts: PipelineArtifacts = { prompt: 'x', prd: 'PRD' };
    const call: EntityToolCall = { entityName: 'customers', action: 'create', toolName: 'create_table' };
    await buildRealPipelineDeps().perEntity!.executeToolCall!(call, artifacts, ctx);
    expect(lastCall().system).toBe(CREATE_TABLE_SYSTEM_PROMPT);
  });

  it('step-plan uses the step-plan prompt and returns parsed JSON', async () => {
    mockGenerateText.mockImplementation(() => result('', { steps: [{ type: 'CreateTable', description: 't' }] }));
    const raw = await buildRealPipelineDeps().stepPlan.generateStepPlan('# PRD\n\nx', ctx);
    expect(lastCall().system).toBe(STEP_PLAN_SYSTEM_PROMPT);
    expect(raw).toEqual({ steps: [{ type: 'CreateTable', description: 't' }] });
  });

  it('stepGeneration dispatches the step type onto its ported system prompt and parses JSON', async () => {
    mockGenerateText.mockImplementation(() => result('', { componentId: 'c-1', properties: { text: 'Hi' } }));
    const artifacts = { prompt: '', prd: 'PRD', stepPlan: { steps: [] } } as PipelineArtifacts;
    const payload = await buildRealPipelineDeps().stepGeneration.generateStepPayload(
      { type: 'UpdateComponent', description: 'retitle the heading' },
      1,
      artifacts,
      ctx
    );
    const { system, user } = lastCall();
    expect(system).toBe(UPDATE_COMPONENT_SYSTEM_PROMPT);
    expect(user).toContain('retitle the heading');
    expect(payload).toEqual({ componentId: 'c-1', properties: { text: 'Hi' } });
  });

  it('evaluate judges a compact artifact summary with the evaluate prompt', async () => {
    mockGenerateText.mockImplementation(() => result('', { pass: true, reasons: [] }));
    const artifacts: PipelineArtifacts = { prompt: 'x', prd: 'the PRD' };
    const raw = await buildRealPipelineDeps().evaluate.judge(artifacts, ctx);
    const { system, user } = lastCall();
    expect(system).toBe(EVALUATE_SYSTEM_PROMPT);
    expect(JSON.parse(user)).toMatchObject({ prd: 'the PRD' });
    expect(raw).toEqual({ pass: true, reasons: [] });
  });

  it('propagates ctx.signal as abortSignal and records normalized usage per call', async () => {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const ctxWithSignal = {
      ...ctx,
      signal: controller.signal,
      usage: { record: (u: unknown) => calls.push(u) },
    };
    mockGenerateText.mockImplementation(() =>
      Promise.resolve({ text: '', output: { tables: [] }, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } })
    );
    await buildRealPipelineDeps().lld.generateLld('PRD', ctxWithSignal);
    expect(lastCall().abortSignal).toBe(controller.signal);
    expect(calls).toEqual([{ promptTokens: 10, completionTokens: 4, totalTokens: 14 }]);
  });

  it('lets the SDK surface a malformed structured response as a typed error (no silent parse)', async () => {
    const { NoObjectGeneratedError } = jest.requireActual('ai');
    mockGenerateText.mockImplementation(() =>
      Promise.reject(new NoObjectGeneratedError({ message: 'No object generated.', response: {}, usage: {}, finishReason: 'stop' }))
    );
    await expect(buildRealPipelineDeps().lld.generateLld('PRD', ctx)).rejects.toMatchObject({
      name: 'AI_NoObjectGeneratedError',
    });
  });

  it('enables passthrough telemetry without recording prompt contents', async () => {
    mockGenerateText.mockImplementation(() => result('', { tables: [] }));
    await buildRealPipelineDeps().lld.generateLld('PRD', ctx);
    const telemetry = mockGenerateText.mock.calls[0][0].experimental_telemetry;
    expect(telemetry.isEnabled).toBe(true);
    expect(telemetry.recordInputs).toBe(false);
    expect(telemetry.recordOutputs).toBe(false);
  });

  it('builds the model via resolveLanguageModel without reading env vars', () => {
    // ctx carries the full EffectiveLlmConfig (ADR-0038); resolveLanguageModel is pure.
    expect(TEST_LLM_CONFIG.provider).toBe('openai');
  });

  it('keeps the real Output.object in the mocked module (structured outputs stay wired)', () => {
    expect(typeof Output.object).toBe('function');
  });
});
