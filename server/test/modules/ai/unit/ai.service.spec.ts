// server/test/modules/ai/unit/ai.service.spec.ts
//
// Ticket #23: CreateTable schema generation must let the model express foreign keys
// (and the execute path must forward them to the backend). This suite pins the two-axis
// seam: the createTableTool schema (axis 1) and the executeCreateTableStep mapping
// (axis 2). The offline harness mocks the AI gateway, AgentsService.CreateTable, and the
// underlying tooljet-db table-operations service so the specs run without a DB.
import { AiService, createTableTool, CREATE_TABLE_SYSTEM_PROMPT } from '@modules/ai/service';

const buildMockAiUtilService = () => ({
  AIGatewayGenerate: jest.fn(),
  sendSSE: jest.fn(),
});

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
});

const buildMockRepositories = () => ({
  aiConversationRepository: { findConversation: jest.fn() },
  aiConversationMessageRepository: { findMessages: jest.fn() },
  artifactRepository: { find: jest.fn(), create: jest.fn() },
  stepRepository: { updateOne: jest.fn() },
  versionRepository: { findVersion: jest.fn() },
  aiResponseVoteRepository: { find: jest.fn(), upsert: jest.fn() },
  appInventoryService: { findAppById: jest.fn() },
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

  return { service, aiUtilService, agentsService };
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

    await service.executeCreateTableStep(
      { type: 'CreateTable', description: 'payments' } as any,
      { prd: 'build payments', organizationId: 'org-1', appVersionId: 'v1', priorResults: [] } as any,
    );

    const [, tableParams] = agentsService.CreateTable.mock.calls[0];
    expect(tableParams.foreign_keys).toEqual(foreignKeys);
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
