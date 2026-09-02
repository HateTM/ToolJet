import { buildDefaultPipeline, runPipeline } from '../../src/pipeline/index';
import { makeTestCtx } from './ctx';

describe('buildDefaultPipeline', () => {
  it('assembles the eight ADR-0028/ADR-0040/ADR-0048 stages in order', () => {
    const stages = buildDefaultPipeline({
      classify: { classify: jest.fn() },
      prd: { generatePrd: jest.fn() },
      lld: { generateLld: jest.fn() },
      stepPlan: { generateStepPlan: jest.fn() },
      stepGeneration: { generateStepPayload: jest.fn() },
      evaluate: { judge: jest.fn() },
    });

    expect(stages.map((s) => s.name)).toEqual([
      'classify',
      'prd',
      'lld',
      'feature-planner',
      'per-entity',
      'step-plan',
      'step-generation',
      'evaluate',
    ]);
  });

  it('runs end-to-end through runPipeline with fully faked LLM dependencies', async () => {
    const ctx = makeTestCtx();
    const stages = buildDefaultPipeline({
      classify: { classify: jest.fn().mockResolvedValue({ intent: 'build_app', confidence: 0.9 }) },
      prd: { generatePrd: jest.fn().mockResolvedValue('# PRD') },
      lld: {
        generateLld: jest.fn().mockResolvedValue({
          tables: [
            {
              table_name: 'users',
              columns: [{ column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } }],
            },
          ],
        }),
      },
      stepPlan: {
        generateStepPlan: jest.fn().mockResolvedValue({
          steps: [{ type: 'CreateTable', description: 'create users', phase: 'Tables' }],
        }),
      },
      stepGeneration: { generateStepPayload: jest.fn() },
      evaluate: { judge: jest.fn().mockResolvedValue({ pass: true, reasons: [] }) },
    });

    const result = await runPipeline(stages, { prompt: 'build a CRM' }, ctx);

    expect(result.classification?.intent).toBe('build_app');
    expect(result.prd).toBe('# PRD');
    expect(result.lld?.tables).toHaveLength(1);
    expect(result.featurePlan?.items.map((i) => i.entityName)).toEqual(['users']);
    expect(result.entityToolCalls).toEqual([{ entityName: 'users', action: 'create', toolName: 'create_table' }]);
    expect(result.stepPlan?.steps).toHaveLength(1);
    expect(result.stepPlan?.steps[0]).toMatchObject({
      type: 'CreateTable',
      description: 'create users',
      phase: 'Tables',
    });
    expect(result.generatedSteps).toEqual([]);
    expect(result.evaluation).toEqual({ pass: true, reasons: [] });
  });

  it('short-circuits after classify when the classification is unsupported', async () => {
    const ctx = makeTestCtx();
    const generatePrd = jest.fn();
    const generateLld = jest.fn();
    const generateStepPlan = jest.fn();
    const judge = jest.fn();
    const stages = buildDefaultPipeline({
      classify: { classify: jest.fn().mockResolvedValue({ intent: 'unsupported', confidence: 0 }) },
      prd: { generatePrd },
      lld: { generateLld },
      stepPlan: { generateStepPlan },
      stepGeneration: { generateStepPayload: jest.fn() },
      evaluate: { judge },
    });

    const result = await runPipeline(stages, { prompt: 'write me a poem' }, ctx);

    expect(result.classification).toEqual({ intent: 'unsupported', confidence: 0 });
    expect(result.prd).toBeUndefined();
    expect(result.lld).toBeUndefined();
    expect(result.evaluation).toBeUndefined();
    expect(generatePrd).not.toHaveBeenCalled();
    expect(generateLld).not.toHaveBeenCalled();
    expect(generateStepPlan).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });
});
