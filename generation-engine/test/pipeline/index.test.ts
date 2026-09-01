import { buildDefaultPipeline, runPipeline } from '../../src/pipeline/index';
import { StageContext } from '../../src/pipeline/types';

describe('buildDefaultPipeline', () => {
  it('assembles the six ADR-0028 stages in order', () => {
    const stages = buildDefaultPipeline({
      classify: { classify: jest.fn() },
      prd: { generatePrd: jest.fn() },
      lld: { generateLld: jest.fn() },
      evaluate: { judge: jest.fn() },
    });

    expect(stages.map((s) => s.name)).toEqual(['classify', 'prd', 'lld', 'feature-planner', 'per-entity', 'evaluate']);
  });

  it('runs end-to-end through runPipeline with fully faked LLM dependencies', async () => {
    const ctx: StageContext = { organizationId: 'org-1' };
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
      evaluate: { judge: jest.fn().mockResolvedValue({ pass: true, reasons: [] }) },
    });

    const result = await runPipeline(stages, { prompt: 'build a CRM' }, ctx);

    expect(result.classification?.intent).toBe('build_app');
    expect(result.prd).toBe('# PRD');
    expect(result.lld?.tables).toHaveLength(1);
    expect(result.featurePlan?.items.map((i) => i.entityName)).toEqual(['users']);
    expect(result.entityToolCalls).toEqual([{ entityName: 'users', action: 'create', toolName: 'create_table' }]);
    expect(result.evaluation).toEqual({ pass: true, reasons: [] });
  });

  it('short-circuits after classify when the classification is unsupported', async () => {
    const ctx: StageContext = { organizationId: 'org-1' };
    const generatePrd = jest.fn();
    const generateLld = jest.fn();
    const judge = jest.fn();
    const stages = buildDefaultPipeline({
      classify: { classify: jest.fn().mockResolvedValue({ intent: 'unsupported', confidence: 0 }) },
      prd: { generatePrd },
      lld: { generateLld },
      evaluate: { judge },
    });

    const result = await runPipeline(stages, { prompt: 'write me a poem' }, ctx);

    expect(result.classification).toEqual({ intent: 'unsupported', confidence: 0 });
    expect(result.prd).toBeUndefined();
    expect(result.lld).toBeUndefined();
    expect(result.evaluation).toBeUndefined();
    expect(generatePrd).not.toHaveBeenCalled();
    expect(generateLld).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });
});
