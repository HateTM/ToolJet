import { buildFeaturePlanFromLld, buildFeaturePlannerStage } from '../../src/pipeline/feature-planner';
import { LldSchema, PipelineArtifacts, StageContext } from '../../src/pipeline/types';

const schema: LldSchema = {
  tables: [
    {
      table_name: 'posts',
      columns: [],
      foreign_keys: [{ column_name: 'user_id', references_table: 'users', references_column: 'id' }],
    },
    { table_name: 'users', columns: [] },
  ],
};

describe('buildFeaturePlanFromLld', () => {
  it('orders items so a dependency comes before its dependent', () => {
    const plan = buildFeaturePlanFromLld(schema);
    const names = plan.items.map((i) => i.entityName);
    expect(names.indexOf('users')).toBeLessThan(names.indexOf('posts'));
  });

  it("records each item's direct dependencies", () => {
    const plan = buildFeaturePlanFromLld(schema);
    const posts = plan.items.find((i) => i.entityName === 'posts');
    expect(posts?.dependsOn).toEqual(['users']);
    const users = plan.items.find((i) => i.entityName === 'users');
    expect(users?.dependsOn).toEqual([]);
  });
});

describe('buildFeaturePlannerStage', () => {
  const ctx: StageContext = { organizationId: 'org-1' };

  it('throws if the LLD stage has not run', async () => {
    const stage = buildFeaturePlannerStage();
    await expect(stage.run({ prompt: 'x' }, ctx)).rejects.toThrow(/requires artifacts.lld/);
  });

  it('defaults to the deterministic table-derived plan with no deps.planFeatures', async () => {
    const stage = buildFeaturePlannerStage();
    const artifacts: PipelineArtifacts = { prompt: 'x', lld: schema };

    const result = await stage.run(artifacts, ctx);

    expect(result.featurePlan?.items.map((i) => i.entityName)).toEqual(['users', 'posts']);
  });

  it('runs the deterministic plan through deps.planFeatures when provided', async () => {
    const planFeatures = jest.fn().mockImplementation(async (plan) => ({
      items: [...plan.items, { entityName: 'extra', dependsOn: [] }],
    }));
    const stage = buildFeaturePlannerStage({ planFeatures });
    const artifacts: PipelineArtifacts = { prompt: 'x', lld: schema };

    const result = await stage.run(artifacts, ctx);

    expect(planFeatures).toHaveBeenCalled();
    expect(result.featurePlan?.items.map((i) => i.entityName)).toContain('extra');
  });
});
