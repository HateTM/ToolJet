import { routeEntityToolCalls, buildPerEntityStage } from '../../src/pipeline/per-entity';
import { FeaturePlan, PipelineArtifacts, StageContext } from '../../src/pipeline/types';

const plan: FeaturePlan = {
  items: [
    { entityName: 'users', dependsOn: [] },
    { entityName: 'posts', dependsOn: ['users'] },
  ],
};

describe('routeEntityToolCalls', () => {
  it('routes every entity to create when nothing exists yet', () => {
    const calls = routeEntityToolCalls(plan);
    expect(calls).toEqual([
      { entityName: 'users', action: 'create', toolName: 'create_table' },
      { entityName: 'posts', action: 'create', toolName: 'create_table' },
    ]);
  });

  it('routes an existing entity to update and a new one to create — distinct tool-calls per entity', () => {
    const calls = routeEntityToolCalls(plan, new Set(['users']));
    expect(calls).toEqual([
      { entityName: 'users', action: 'update', toolName: 'update_table' },
      { entityName: 'posts', action: 'create', toolName: 'create_table' },
    ]);
  });
});

describe('buildPerEntityStage', () => {
  const ctx: StageContext = { organizationId: 'org-1' };

  it('throws if the feature-planner stage has not run', async () => {
    const stage = buildPerEntityStage();
    await expect(stage.run({ prompt: 'x' }, ctx)).rejects.toThrow(/requires artifacts.featurePlan/);
  });

  it('stores routed tool-calls without executing them when no executeToolCall dep is given', async () => {
    const stage = buildPerEntityStage();
    const artifacts: PipelineArtifacts = { prompt: 'x', featurePlan: plan };

    const result = await stage.run(artifacts, ctx);

    expect(result.entityToolCalls).toHaveLength(2);
  });

  it('invokes executeToolCall once per routed call, in order', async () => {
    const executeToolCall = jest.fn().mockResolvedValue(undefined);
    const stage = buildPerEntityStage({ executeToolCall });
    const artifacts: PipelineArtifacts = { prompt: 'x', featurePlan: plan };

    await stage.run(artifacts, ctx);

    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(executeToolCall.mock.calls[0][0].entityName).toBe('users');
    expect(executeToolCall.mock.calls[1][0].entityName).toBe('posts');
  });
});
