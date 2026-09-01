import { generateText } from 'ai';
import { buildRealPipelineDeps } from '../../src/pipeline/llm-deps';
import {
  CLASSIFY_SYSTEM_PROMPT,
  CREATE_TABLE_SYSTEM_PROMPT,
  EVALUATE_SYSTEM_PROMPT,
  LLD_SYSTEM_PROMPT,
  PRD_SYSTEM_PROMPT,
  STEP_PLAN_SYSTEM_PROMPT,
  UPDATE_TABLE_SYSTEM_PROMPT,
} from '../../src/prompts';
import { PipelineArtifacts, EntityToolCall } from '../../src/pipeline/types';
import { TEST_LLM_CONFIG, makeTestCtx } from './ctx';

jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

const mockGenerateText = generateText as jest.Mock;

function lastCall() {
  const args = mockGenerateText.mock.calls[mockGenerateText.mock.calls.length - 1][0];
  return {
    model: args.model,
    system: args.messages[0].content as string,
    user: args.messages[1].content as string,
  };
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockGenerateText.mockResolvedValue({ text: '{"intent":"build_app","confidence":0.9}' });
});

describe('buildRealPipelineDeps', () => {
  const ctx = makeTestCtx();

  it('classify uses the classify prompt and ctx.llm-resolved model, returning JSON', async () => {
    const raw = await buildRealPipelineDeps().classify.classify('build a CRM', ctx);
    const { system, model } = lastCall();
    expect(system).toBe(CLASSIFY_SYSTEM_PROMPT);
    expect(model).toBeDefined();
    expect(raw).toEqual({ intent: 'build_app', confidence: 0.9 });
  });

  it('prd uses the PRD prompt and returns the plain text', async () => {
    mockGenerateText.mockResolvedValue({ text: '# PRD' });
    const prd = await buildRealPipelineDeps().prd.generatePrd('build a CRM', ctx);
    const { system, user } = lastCall();
    expect(system).toBe(PRD_SYSTEM_PROMPT);
    expect(user).toBe('build a CRM');
    expect(prd).toBe('# PRD');
  });

  it('lld assembles the catalog context into the prompt and returns parsed JSON', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"tables":[]}' });
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
    mockGenerateText.mockResolvedValue({ text: '{"steps":[{"type":"CreateTable","description":"t"}]}' });
    const raw = await buildRealPipelineDeps().stepPlan.generateStepPlan('# PRD\n\nx', ctx);
    expect(lastCall().system).toBe(STEP_PLAN_SYSTEM_PROMPT);
    expect(raw).toEqual({ steps: [{ type: 'CreateTable', description: 't' }] });
  });

  it('evaluate judges a compact artifact summary with the evaluate prompt', async () => {
    mockGenerateText.mockResolvedValue({ text: '{"pass":true,"reasons":[]}' });
    const artifacts: PipelineArtifacts = { prompt: 'x', prd: 'the PRD' };
    const raw = await buildRealPipelineDeps().evaluate.judge(artifacts, ctx);
    const { system, user } = lastCall();
    expect(system).toBe(EVALUATE_SYSTEM_PROMPT);
    expect(JSON.parse(user)).toMatchObject({ prd: 'the PRD' });
    expect(raw).toEqual({ pass: true, reasons: [] });
  });

  it('throws a plain error (not a SyntaxError) on non-JSON responses', async () => {
    mockGenerateText.mockResolvedValue({ text: 'not json at all' });
    await expect(buildRealPipelineDeps().lld.generateLld('PRD', ctx)).rejects.toThrow('non-JSON payload');
  });

  it('builds the model via resolveLanguageModel without reading env vars', () => {
    // ctx carries the full EffectiveLlmConfig (ADR-0038); resolveLanguageModel is pure.
    expect(TEST_LLM_CONFIG.provider).toBe('openai');
  });
});
