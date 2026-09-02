// server/test/modules/ai/unit/ai.service.spec.ts
//
// Ticket #23: CreateTable schema generation must let the model express foreign keys
// (and the execute path must forward them to the backend). This suite pins the two-axis
// seam: the createTableTool schema (axis 1) and the executeCreateTableStep mapping
// (axis 2). The offline harness mocks the AI gateway, AgentsService.CreateTable, and the
// underlying tooljet-db table-operations service so the specs run without a DB.
import {
  AiService,
  createTableTool,
  proposeStepPlanTool,
  CREATE_TABLE_SYSTEM_PROMPT,
  STEP_PLAN_SYSTEM_PROMPT,
} from '@modules/ai/service';

const buildMockAiUtilService = () => ({
  AIGatewayGenerate: jest.fn(),
  sendSSE: jest.fn(),
  fitMessagesToContextWindowForOrg: jest.fn().mockImplementation((orgId: string, msgs: any[]) => ({ messages: msgs, truncated: [] })),
});

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
  SeedTable: jest.fn(),
  // Ticket #23's FK pre-flight consults the org's existing tables when an FK target is not
  // among priorResults; tests default to "no pre-existing tables" and override as needed.
  ViewTables: jest.fn().mockResolvedValue([]),
  UpdateComponent: jest.fn(),
});

const buildMockRepositories = () => ({
  aiConversationRepository: { findConversation: jest.fn() },
  aiConversationMessageRepository: { findMessages: jest.fn() },
  artifactRepository: { find: jest.fn(), create: jest.fn() },
  stepRepository: { updateOne: jest.fn(), createOne: jest.fn(), findById: jest.fn() },
  versionRepository: { findVersion: jest.fn() },
  aiResponseVoteRepository: { find: jest.fn(), upsert: jest.fn() },
  appInventoryService: {
    findAppById: jest.fn(),
    // Ticket #66: UpdateComponent's own execution-time context — defaults to "nothing built
    // yet", overridden per test with the target component's real id.
    renderComponentIndex: jest.fn().mockResolvedValue('Existing components already in this app: none yet.'),
  },
  dataSourceInventoryService: { findDataSourceByKind: jest.fn() },
});

const buildAiService = (overrides: any = {}) => {
  const aiUtilService = overrides.aiUtilService ?? buildMockAiUtilService();
  const agentsService = overrides.agentsService ?? buildMockAgentsService();
  const repositories = overrides.repositories ?? buildMockRepositories();

  const service = new AiService(
    aiUtilService,
    repositories.aiConversationRepository,
    repositories.aiConversationMessageRepository,
    agentsService,
    repositories.artifactRepository,
    repositories.stepRepository,
    repositories.versionRepository,
    repositories.aiResponseVoteRepository,
    repositories.appInventoryService,
    repositories.dataSourceInventoryService
  );

  return { service, aiUtilService, agentsService, repositories };
};

const makeToolCall = (args: any) => ({
  toolName: 'createTable',
  args,
});

describe('AiService.executeCreateTableStep — foreign keys (ticket #23)', () => {
  it('forwards foreign_keys declared in the tool call into tableParams and to CreateTable', async () => {
    const { service, aiUtilService, agentsService } = buildAiService();
    const foreignKeys = [
      {
        column_names: ['user_id'],
        referenced_table_name: 'users',
        referenced_column_names: ['id'],
        on_delete: 'CASCADE',
        on_update: 'RESTRICT',
      },
    ];
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [makeToolCall({ table_name: 'orders', columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }], foreign_keys: foreignKeys })],
    });

    const created = { id: 'tjdb-uuid', table_name: 'orders' };
    agentsService.CreateTable.mockResolvedValue(created);
    // 'users' is not among priorResults here — the pre-flight must find it among the org's
    // pre-existing tables for the step to proceed.
    agentsService.ViewTables.mockResolvedValue([{ id: 'users-uuid', tableName: 'users' }]);

    const result = await service.executeCreateTableStep(
      { type: 'CreateTable', description: 'orders' } as any,
      { prd: 'build an orders table', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any,
    );

    expect(agentsService.CreateTable).toHaveBeenCalledTimes(1);
    const [organizationId, tableParams] = agentsService.CreateTable.mock.calls[0];
    expect(organizationId).toBe('org-1');
    expect(tableParams.table_name).toBe('orders');
    expect(tableParams.foreign_keys).toEqual(foreignKeys);

    // The FKs must survive into the returned artifact props so downstream steps can see them.
    expect(result.props.foreign_keys).toEqual(foreignKeys);
    expect(result.content.table_name).toBe('orders');
    expect(result.identifier).toBe('orders');
  });

  it('omits foreign_keys entirely when the model does not declare any', async () => {
    const { service, aiUtilService, agentsService } = buildAiService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [makeToolCall({
        table_name: 'products',
        columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
      })],
    });
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'products' });

    const result = await service.executeCreateTableStep(
      { type: 'CreateTable', description: 'products' } as any,
      { prd: 'build a products table', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any,
    );

    const [, tableParams] = agentsService.CreateTable.mock.calls[0];
    expect(tableParams.foreign_keys).toBeUndefined();
    expect(result.props.foreign_keys).toBeUndefined();
  });

  it('still forwards foreign_keys when referenced columns are plain (non-PK) columns', async () => {
    const { service, aiUtilService, agentsService } = buildAiService();
    const foreignKeys = [
      {
        column_names: ['customer_id'],
        referenced_table_name: 'customers',
        referenced_column_names: ['id'],
      },
    ];
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [makeToolCall({
        table_name: 'payments',
        columns: [
          { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true },
          { column_name: 'customer_id', data_type: 'text', is_primary_key: false, is_not_null: true, is_unique: false },
        ],
        foreign_keys: foreignKeys,
      })],
    });
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'payments' });
    agentsService.ViewTables.mockResolvedValue([{ id: 'customers-uuid', tableName: 'customers' }]);

    await service.executeCreateTableStep(
      { type: 'CreateTable', description: 'payments' } as any,
      { prd: 'build payments', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any,
    );

    const [, tableParams] = agentsService.CreateTable.mock.calls[0];
    expect(tableParams.foreign_keys).toEqual(foreignKeys);
  });
});

/** @group ai-builder */
describe('AiService.executeUpdateComponentStep (ticket #66)', () => {
  const componentIndex =
    'Existing components already in this app:\n- Text "Welcome" (id: component-1, page: "Home")';

  it("resolves the model's componentId against the real component index and delegates the merge to AgentsService.UpdateComponent", async () => {
    const { service, aiUtilService, agentsService, repositories } = buildAiService();
    repositories.appInventoryService.renderComponentIndex.mockResolvedValue(componentIndex);
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [{ toolName: 'updateComponent', args: { componentId: 'component-1', properties: { text: 'New title' } } }],
    });
    agentsService.UpdateComponent.mockResolvedValue({
      id: 'component-1',
      type: 'Text',
      patch: { properties: { text: { value: 'New title' } } },
      previous: { properties: { text: { value: 'Old title' } }, styles: {} },
    });

    const result = await service.executeUpdateComponentStep(
      { type: 'UpdateComponent', description: 'change the welcome text' } as any,
      { prd: 'Change the welcome text to "New title"', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any
    );

    expect(agentsService.UpdateComponent).toHaveBeenCalledWith('v1', 'org-1', 'component-1', {
      properties: { text: 'New title' },
      styles: undefined,
    });
    expect(result.identifier).toBe('component-1');
    expect(result.content.previous).toEqual({ properties: { text: { value: 'Old title' } }, styles: {} });
  });

  it('throws a retryable, meaningful error for a hallucinated componentId instead of delegating to AgentsService.UpdateComponent', async () => {
    const { service, aiUtilService, agentsService, repositories } = buildAiService();
    repositories.appInventoryService.renderComponentIndex.mockResolvedValue(componentIndex);
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [{ toolName: 'updateComponent', args: { componentId: 'ghost-component', properties: { text: 'x' } } }],
    });

    await expect(
      service.executeUpdateComponentStep(
        { type: 'UpdateComponent', description: 'change something' } as any,
        { prd: 'irrelevant', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any
      )
    ).rejects.toThrow(/does not match any existing component/);
    expect(agentsService.UpdateComponent).not.toHaveBeenCalled();
  });

  it('accepts an empty patch ({} — "no changes") without erroring', async () => {
    const { service, aiUtilService, agentsService, repositories } = buildAiService();
    repositories.appInventoryService.renderComponentIndex.mockResolvedValue(componentIndex);
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [{ toolName: 'updateComponent', args: { componentId: 'component-1' } }],
    });
    agentsService.UpdateComponent.mockResolvedValue({
      id: 'component-1',
      type: 'Text',
      patch: {},
      previous: {},
      noop: true,
    });

    const result = await service.executeUpdateComponentStep(
      { type: 'UpdateComponent', description: 'no actual change needed' } as any,
      { prd: 'irrelevant', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any
    );

    expect(agentsService.UpdateComponent).toHaveBeenCalledWith('v1', 'org-1', 'component-1', {
      properties: undefined,
      styles: undefined,
    });
    expect(result.content.noop).toBe(true);
  });
});

/** @group ai-builder */
describe('UpdateComponent step vocabulary (ticket #66)', () => {
  it('STEP_PLAN_SYSTEM_PROMPT tells the planner about UpdateComponent and the existing-components grounding', () => {
    expect(STEP_PLAN_SYSTEM_PROMPT).toMatch(/UpdateComponent/);
    expect(STEP_PLAN_SYSTEM_PROMPT).toMatch(/Existing components already in this app/);
  });
});

/** @group ai-builder */
describe('CreateTable system prompt advertises foreign keys (ticket #23)', () => {
  it('mentions the foreign_keys field and its on_delete/on_update actions', () => {
    expect(CREATE_TABLE_SYSTEM_PROMPT).toMatch(/foreign_keys/i);
    expect(CREATE_TABLE_SYSTEM_PROMPT).toMatch(/on_delete/i);
    expect(CREATE_TABLE_SYSTEM_PROMPT).toMatch(/on_update/i);
    // It must tell the model when to use the field (referencing existing tables), not omit it.
    expect(CREATE_TABLE_SYSTEM_PROMPT).toMatch(/already exist/i);
  });
});

/** @group ai-builder */
describe('createTableTool schema accepts foreign keys (axis 1)', () => {
  // createTableTool is defined in service.ts; importing it here proves the LLM-facing
  // schema advertises foreign_keys so the model can express relationships.
  const schema = createTableTool.parameters as any;

  it('accepts a foreign_keys array with column_names, referenced_table_name, referenced_column_names, on_delete/on_update', () => {
    const parsed = schema.parse({
      table_name: 'orders',
      columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
      foreign_keys: [
        {
          column_names: ['customer_id'],
          referenced_table_name: 'customers',
          referenced_column_names: ['id'],
          on_delete: 'CASCADE',
          on_update: 'RESTRICT',
        },
      ],
    });

    expect(Array.isArray(parsed.foreign_keys)).toBe(true);
    expect(parsed.foreign_keys[0].referenced_table_name).toBe('customers');
    expect(parsed.foreign_keys[0].on_delete).toBe('CASCADE');
  });

  it('rejects an invalid on_delete operation', () => {
    expect(() =>
      schema.parse({
        table_name: 'orders',
        columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
        foreign_keys: [{ column_names: ['customer_id'], referenced_table_name: 'customers', referenced_column_names: ['id'], on_delete: 'BOOM' }],
      })
    ).toThrow(/invalid/i);
  });
});

/** @group ai-builder */
describe('createTableTool schema accepts indexes (ticket #23)', () => {
  const schema = createTableTool.parameters as any;

  it('accepts an indexes array of column groups with optional uniqueness', () => {
    const parsed = schema.parse({
      table_name: 'orders',
      columns: [
        { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true },
        { column_name: 'customer_id', data_type: 'integer', is_primary_key: false, is_not_null: true, is_unique: false },
      ],
      indexes: [{ column_names: ['customer_id'] }, { column_names: ['customer_id', 'created_at'], is_unique: true }],
    });

    expect(parsed.indexes).toEqual([{ column_names: ['customer_id'] }, { column_names: ['customer_id', 'created_at'], is_unique: true }]);
  });

  it('rejects an index with no columns', () => {
    expect(() =>
      schema.parse({
        table_name: 'orders',
        columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
        indexes: [{ column_names: [] }],
      })
    ).toThrow();
  });

  it('indexes are optional', () => {
    const parsed = schema.parse({
      table_name: 'orders',
      columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
    });
    expect(parsed.indexes).toBeUndefined();
  });

  it('CREATE_TABLE_SYSTEM_PROMPT advertises the indexes field', () => {
    expect(CREATE_TABLE_SYSTEM_PROMPT).toMatch(/indexes/i);
  });
});

const PLANNED_TABLE = {
  table_name: 'tasks',
  columns: [
    { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true },
    {
      column_name: 'title',
      data_type: 'character varying',
      is_primary_key: false,
      is_not_null: true,
      is_unique: false,
    },
    { column_name: 'done', data_type: 'boolean', is_primary_key: false, is_not_null: false, is_unique: false },
  ],
};

const SEED_ROWS = [
  { title: 'Buy milk', done: false },
  { title: 'Ship the app', done: false },
];

/** @group ai-builder */
describe('AiService.executeCreateTableStep — planned seed rows (ticket #48)', () => {
  const plannedStep = (overrides: any = {}) => ({
    type: 'CreateTable',
    description: 'tasks',
    plannedTable: PLANNED_TABLE,
    ...overrides,
  });
  const context = { prd: 'a task manager', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any;

  it('inserts planned seed rows right after creating the table, passing the primary key columns', async () => {
    const { service, agentsService } = buildAiService();
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'tasks' });
    agentsService.SeedTable.mockResolvedValue({ inserted: 2, updated: 0 });

    const result = await service.executeCreateTableStep(plannedStep({ plannedSeedRows: SEED_ROWS }), context);

    expect(agentsService.CreateTable).toHaveBeenCalledTimes(1);
    expect(agentsService.SeedTable).toHaveBeenCalledTimes(1);
    const [organizationId, tableId, primaryKeyColumns, rows] = agentsService.SeedTable.mock.calls[0];
    expect(organizationId).toBe('org-1');
    expect(tableId).toBe('tjdb-uuid');
    expect(primaryKeyColumns).toEqual(['id']);
    expect(rows).toEqual(SEED_ROWS);
    // The seed outcome must ride on the artifact content so later steps (and skip/undo
    // accounting) see what this step actually produced.
    expect(result.content.seed).toEqual({ inserted: 2, updated: 0 });
  });

  it('does not seed a CreateTable step without planned seed rows', async () => {
    const { service, agentsService } = buildAiService();
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'tasks' });

    await service.executeCreateTableStep(plannedStep(), context);

    expect(agentsService.SeedTable).not.toHaveBeenCalled();
  });

  it('does not seed when the planned rows are malformed — the table still gets created', async () => {
    const { service, agentsService } = buildAiService();
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'tasks' });

    await service.executeCreateTableStep(plannedStep({ plannedSeedRows: [{ title: { nested: 'object' } }] }), context);

    expect(agentsService.CreateTable).toHaveBeenCalledTimes(1);
    expect(agentsService.SeedTable).not.toHaveBeenCalled();
  });

  it('lets a seeding failure propagate into the retry loop', async () => {
    const { service, agentsService } = buildAiService();
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'tasks' });
    agentsService.SeedTable.mockRejectedValue(new Error('Seeding the table failed:boom'));

    await expect(service.executeCreateTableStep(plannedStep({ plannedSeedRows: SEED_ROWS }), context)).rejects.toThrow(
      /Seeding the table failed/
    );
  });
});

/** @group ai-builder */
describe('step planner advertises seed_rows (ticket #48)', () => {
  it('STEP_PLAN_SYSTEM_PROMPT tells the model when to propose seed_rows', () => {
    expect(STEP_PLAN_SYSTEM_PROMPT).toMatch(/seed_rows/i);
    expect(STEP_PLAN_SYSTEM_PROMPT).toMatch(/sample or starting data/i);
    // And the guardrail: never invent seed data the PRD does not call for.
    expect(STEP_PLAN_SYSTEM_PROMPT).toMatch(/never invent seed rows/i);
  });

  it('proposeStepPlanTool accepts a CreateTable step with well-formed seed_rows', () => {
    const schema = proposeStepPlanTool.parameters as any;
    const parsed = schema.parse({
      steps: [
        {
          type: 'CreateTable',
          description: 'tasks table with seed data',
          table: PLANNED_TABLE,
          seed_rows: SEED_ROWS,
        },
      ],
    });
    expect(parsed.steps[0].seed_rows).toEqual(SEED_ROWS);
  });

  it('proposeStepPlanTool still accepts a CreateTable step without seed_rows (optional)', () => {
    const schema = proposeStepPlanTool.parameters as any;
    const parsed = schema.parse({
      steps: [{ type: 'CreateTable', description: 'tasks table', table: PLANNED_TABLE }],
    });
    expect(parsed.steps[0].seed_rows).toBeUndefined();
  });
});

/** @group ai-builder */
describe('planned seed rows are consistent with the planned schema (ticket #48 spec: "INSERTs consistent with the planned schema")', () => {
  // generateStepPlan's plan-time gate, exercised through its persist behavior via the
  // step repository mock: a row naming a column the table doesn't have must be dropped
  // (no plannedSeedRows persisted), not left to fail at insert time.
  const buildPersistingHarness = () => {
    const built = buildAiService();
    built.aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'proposeStepPlan',
          args: {
            steps: [
              {
                type: 'CreateTable',
                description: 'tasks',
                table: PLANNED_TABLE,
                seed_rows: [{ title: 'Buy milk', done: false }],
              },
            ],
          },
        },
      ],
    });
    built.repositories.stepRepository.createOne.mockImplementation(async (step: any) => step);
    return built;
  };

  it('persists seed rows whose keys are all real columns of the planned table', async () => {
    const { service, repositories } = buildPersistingHarness();
    await (service as any).generateStepPlan('prd', 'conv-1', 'msg-1', 'org-1', []);

    expect(repositories.stepRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({ plannedSeedRows: [{ title: 'Buy milk', done: false }] })
    );
  });

  it('drops seed rows that name a column the planned table does not have', async () => {
    // Overwrite the gateway call with a hallucinated column.
    const withBadColumn = buildAiService();
    withBadColumn.aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'proposeStepPlan',
          args: {
            steps: [
              {
                type: 'CreateTable',
                description: 'tasks',
                table: PLANNED_TABLE,
                seed_rows: [{ title: 'Buy milk', nonexistent_column: 'x' }],
              },
            ],
          },
        },
      ],
    });
    withBadColumn.repositories.stepRepository.createOne.mockImplementation(async (step: any) => step);

    await (withBadColumn.service as any).generateStepPlan('prd', 'conv-1', 'msg-1', 'org-1', []);

    // A dropped seed is persisted as an absent key (spread-conditional), not an undefined value.
    const persisted = withBadColumn.repositories.stepRepository.createOne.mock.calls[0][0];
    expect(persisted.plannedTable).toEqual(PLANNED_TABLE);
    expect('plannedSeedRows' in persisted).toBe(false);
  });
});

// Increment 5: createQuery gains a "restapi" branch alongside "tooljetdb"/"sql". These pin
// buildRestApiQueryProps and the shared id-resolution it uses (also exercised by the
// pre-existing "sql" branch, buildExternalQueryProps) — retryable hallucinated-id failures
// and the concrete option shape the restapi plugin's runtime actually reads.
describe('AiService.buildRestApiQueryProps (increment 5)', () => {
  const { service } = buildAiService();

  const context = {
    dataSources: [{ id: 'ds-1', name: 'Petstore', kind: 'restapi', tables: [] }],
  } as any;

  it('builds options matching the restapi plugin runtime shape (method/url/headers/params/body)', () => {
    const props = (service as any).buildRestApiQueryProps(
      {
        name: 'get_pet',
        data_source_id: 'ds-1',
        method: 'post',
        url: '/pets/{{components.petId.value}}',
        headers: [{ key: 'X-Trace', value: '1' }],
        params: [{ key: 'limit', value: '10' }],
        body: '{"active": true}',
      },
      context
    );

    expect(props).toEqual({
      name: 'get_pet',
      dataSourceId: 'ds-1',
      options: {
        method: 'post',
        url: '/pets/{{components.petId.value}}',
        url_params: [['limit', '10']],
        headers: [['X-Trace', '1']],
        body_toggle: true,
        raw_body: '{"active": true}',
        json_body: null,
        body: [],
        cookies: [],
      },
    });
  });

  it('defaults to GET and leaves body_toggle off when no body is given', () => {
    const props = (service as any).buildRestApiQueryProps(
      { name: 'list_pets', data_source_id: 'ds-1', url: '/pets' },
      context
    );

    expect(props.options.method).toBe('get');
    expect(props.options.body_toggle).toBe(false);
    expect(props.options.url_params).toEqual([]);
    expect(props.options.headers).toEqual([]);
  });

  it('rejects a missing url', () => {
    expect(() => (service as any).buildRestApiQueryProps({ name: 'x', data_source_id: 'ds-1' }, context)).toThrow(
      /request path\/URL/
    );
  });

  it('rejects a data_source_id that is not among the connected sources, naming what was available (retryable)', () => {
    expect(() =>
      (service as any).buildRestApiQueryProps({ name: 'x', data_source_id: 'not-real', url: '/pets' }, context)
    ).toThrow(/does not match any connected data source.*Petstore \(ds-1\)/s);
  });
});
