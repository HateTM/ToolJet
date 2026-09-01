import { routeEntityToolCalls, buildPerEntityStage, validateUpdateTableCall } from '../../src/pipeline/per-entity';
import { EntityToolCall, FeaturePlan, PipelineArtifacts, StageContext } from '../../src/pipeline/types';

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

describe('validateUpdateTableCall', () => {
  const validPayload = {
    table_name: 'users',
    columns: [
      { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true },
      { column_name: 'email', data_type: 'character varying', is_primary_key: false, is_not_null: true, is_unique: true },
    ],
  };
  const updateCall: EntityToolCall = { entityName: 'users', action: 'update', toolName: 'update_table', payload: validPayload };

  it('returns no problems for a well-formed full-replace payload (ADR-0041)', () => {
    expect(validateUpdateTableCall(updateCall)).toEqual([]);
  });

  it('returns no problems for a valid renames map whose target is a desired column', () => {
    const call: EntityToolCall = {
      ...updateCall,
      payload: { ...validPayload, columns: [...validPayload.columns, { column_name: 'name', data_type: 'character varying', is_primary_key: false, is_not_null: false, is_unique: false }], renames: { user_name: 'name' } },
    };
    expect(validateUpdateTableCall(call)).toEqual([]);
  });

  it('flags a missing payload', () => {
    const call: EntityToolCall = { entityName: 'users', action: 'update', toolName: 'update_table' };
    expect(validateUpdateTableCall(call)).toEqual([expect.stringMatching(/missing its payload/)]);
  });

  it('flags a payload whose table_name does not match the routed entity', () => {
    const call: EntityToolCall = { ...updateCall, payload: { ...validPayload, table_name: 'accounts' } };
    expect(validateUpdateTableCall(call)).toEqual([expect.stringMatching(/does not match the routed entity/)]);
  });

  it('flags an empty columns list', () => {
    const call: EntityToolCall = { ...updateCall, payload: { table_name: 'users', columns: [] } };
    expect(validateUpdateTableCall(call)).toEqual([expect.stringMatching(/non-empty columns list/)]);
  });

  it('flags zero and multiple primary keys', () => {
    const noPk: EntityToolCall = {
      ...updateCall,
      payload: { table_name: 'users', columns: [{ column_name: 'email', data_type: 'character varying', is_primary_key: false, is_not_null: true, is_unique: true }] },
    };
    expect(validateUpdateTableCall(noPk).some((p) => /exactly one primary key column, found 0/.test(p))).toBe(true);

    const twoPk: EntityToolCall = {
      ...updateCall,
      payload: {
        table_name: 'users',
        columns: [
          ...validPayload.columns,
          { column_name: 'other_id', data_type: 'integer', is_primary_key: true, is_not_null: true, is_unique: true },
        ],
      },
    };
    expect(validateUpdateTableCall(twoPk).some((p) => /found 2/.test(p))).toBe(true);
  });

  it('flags a rename whose old name is still in the desired columns list', () => {
    const call: EntityToolCall = { ...updateCall, payload: { ...validPayload, renames: { email: 'email_address' } } };
    const problems = validateUpdateTableCall(call);
    expect(problems.some((p) => /rename source "email" is also in the desired columns list/.test(p))).toBe(true);
    expect(problems.some((p) => /rename target "email_address" is not a column/.test(p))).toBe(true);
  });

  it('ignores non-update calls entirely', () => {
    const createCall: EntityToolCall = { entityName: 'users', action: 'create', toolName: 'create_table' };
    expect(validateUpdateTableCall(createCall)).toEqual([]);
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
