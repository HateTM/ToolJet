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
});
