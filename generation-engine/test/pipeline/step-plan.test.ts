import {
  buildStepPlanStage,
  buildStepPlanStageInput,
  parseStepPlan,
  StepPlanValidationError,
} from '../../src/pipeline/step-plan';
import { makeTestCtx } from './ctx';

const lld: LldSchema = {
  tables: [
    {
      table_name: 'posts',
      columns: [{ column_name: 'title', data_type: 'character varying' }],
      foreign_keys: [{ column_name: 'user_id', references_table: 'users', references_column: 'id' }],
    },
    { table_name: 'users', columns: [{ column_name: 'id', data_type: 'serial' }] },
  ],
};

describe('buildStepPlanStageInput', () => {
  it('includes the PRD, LLD tables, and feature-plan ordering when all present', () => {
    const input = buildStepPlanStageInput({
      prompt: 'x',
      prd: '# PRD text',
      lld,
      featurePlan: {
        items: [
          { entityName: 'users', dependsOn: [] },
          { entityName: 'posts', dependsOn: ['users'] },
        ],
      },
    });
    expect(input).toContain('# PRD text');
    expect(input).toContain('posts(title)');
    expect(input).toContain('users -> posts');
  });

  it('omits the LLD and feature-plan sections when absent', () => {
    const input = buildStepPlanStageInput({ prompt: 'x', prd: '# PRD text' });
    expect(input).toContain('# PRD text');
    expect(input).not.toContain('LLD schema');
    expect(input).not.toContain('Feature-plan ordering');
  });
});

describe('parseStepPlan', () => {
  it('parses a well-formed plan, preserving optional fields', () => {
    const plan = parseStepPlan({
      steps: [
        {
          type: 'CreateTable',
          description: 'create users',
          table: {
            table_name: 'users',
            columns: [
              { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: false, is_unique: false },
            ],
          },
          seed_rows: [{ id: 1 }],
          phase: 'Create data tables',
        },
        { type: 'CreateQuery', description: 'list users' },
      ],
    });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].table?.table_name).toBe('users');
    expect(plan.steps[0].seed_rows).toEqual([{ id: 1 }]);
    expect(plan.steps[0].phase).toBe('Create data tables');
    expect(plan.steps[1].type).toBe('CreateQuery');
  });

  it('throws on a non-object payload', () => {
    expect(() => parseStepPlan('nope')).toThrow(StepPlanValidationError);
    expect(() => parseStepPlan(null)).toThrow(/not a \{ steps: \[...\] \} object/);
  });

  it('throws on an empty step list', () => {
    expect(() => parseStepPlan({ steps: [] })).toThrow(/plan has no steps/);
  });

  it('throws on an unknown step type and on an empty description', () => {
    expect(() => parseStepPlan({ steps: [{ type: 'DeployToProd', description: 'x' }] })).toThrow(
      /unknown type "DeployToProd"/
    );
    expect(() => parseStepPlan({ steps: [{ type: 'CreateQuery', description: '   ' }] })).toThrow(
      /empty or missing description/
    );
  });

  it('drops a malformed planned table but keeps the step (fork policy)', () => {
    const plan = parseStepPlan({ steps: [{ type: 'CreateTable', description: 'x', table: { columns: [] } }] });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].table).toBeUndefined();
  });

  it('drops non-array seed rows but keeps the step', () => {
    const plan = parseStepPlan({ steps: [{ type: 'CreateTable', description: 'x', seed_rows: 'rows' }] });
    expect(plan.steps[0].seed_rows).toBeUndefined();
  });

  it('throws on a non-string phase (client groups by it verbatim)', () => {
    expect(() => parseStepPlan({ steps: [{ type: 'CreateQuery', description: 'x', phase: 3 }] })).toThrow(
      /non-string phase/
    );
  });

  it('collects multiple issues in one error rather than failing on the first', () => {
    try {
      parseStepPlan({
        steps: [
          { type: 'Nope', description: '' },
          { type: 'CreateQuery', description: 'ok' },
        ],
      });
      fail('expected StepPlanValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(StepPlanValidationError);
      expect((err as StepPlanValidationError).issues).toEqual([
        'step 0 has unknown type "Nope"',
        'step 0 has an empty or missing description',
      ]);
    }
  });
});

describe('buildStepPlanStage', () => {
  const ctx = makeTestCtx();
  const artifacts: PipelineArtifacts = { prompt: 'x', prd: '# PRD text', lld };

  it('throws if the PRD stage has not run', async () => {
    const stage = buildStepPlanStage({ generateStepPlan: jest.fn() });
    await expect(stage.run({ prompt: 'x', lld }, ctx)).rejects.toThrow(/requires artifacts.prd/);
  });

  it('throws if the LLD stage has not run', async () => {
    const stage = buildStepPlanStage({ generateStepPlan: jest.fn() });
    await expect(stage.run({ prompt: 'x', prd: '# PRD text' }, ctx)).rejects.toThrow(/requires artifacts.lld/);
  });

  it('feeds the assembled input to deps.generateStepPlan and records the parsed plan', async () => {
    const generateStepPlan = jest.fn().mockResolvedValue({
      steps: [{ type: 'CreateTable', description: 'create users', phase: 'Tables' }],
    });
    const stage = buildStepPlanStage({ generateStepPlan });

    const result = await stage.run(artifacts, ctx);

    expect(generateStepPlan).toHaveBeenCalledWith(expect.stringContaining('# PRD text'), ctx);
    expect(result.stepPlan?.steps).toEqual([
      { type: 'CreateTable', description: 'create users', table: undefined, seed_rows: undefined, phase: 'Tables' },
    ]);
  });

  it('propagates validation errors from the LLM payload', async () => {
    const stage = buildStepPlanStage({ generateStepPlan: jest.fn().mockResolvedValue({ steps: [] }) });
    await expect(stage.run(artifacts, ctx)).rejects.toThrow(StepPlanValidationError);
  });
});
