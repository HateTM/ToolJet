// server/test/modules/ai/unit/create-table-fk-indexes.spec.ts
// Ticket #23: foreign-key pre-flight validation (the #5 validate-and-retry seam, applied to
// CreateTable) and indexes end-to-end through buildTableParams — both the planned-table path
// (deterministic, no LLM) and the per-step LLM path.
import { AiService } from '@modules/ai/service';

const USER = { id: 'user-1', organizationId: 'org-1' } as any;
const PERMISSIONS = { isAdmin: true } as any;

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
  ViewTables: jest.fn().mockResolvedValue([]),
  CreateComponent: jest.fn(),
  CreateQuery: jest.fn(),
  undoArtifact: jest.fn(),
});

// Mirrors the offline unit setup used by service.spec.ts: every AiService dependency mocked,
// nothing touches the DB or the AI gateway.
const buildService = (overrides: Partial<Record<string, any>> = {}) => {
  const aiUtilService = {
    AIGateway: jest.fn(),
    AIGatewayGenerate: jest.fn(),
    sendSSE: jest.fn(),
    initSSE: jest.fn(),
    startHeartbeat: jest.fn(),
    estimateTokenCount: jest.fn().mockReturnValue(0),
    getContextWindow: jest.fn().mockReturnValue(128_000),
    fitMessagesToContextWindow: jest.fn().mockImplementation((msgs) => ({ messages: msgs, truncated: [] })),
    fitMessagesToContextWindowForOrg: jest
      .fn()
      .mockImplementation((_orgId: string, msgs: any[]) => ({ messages: msgs, truncated: [] })),

    createNewConversation: jest.fn(),
    getConversationsList: jest.fn(),
    getConversationById: jest.fn(),
    ...overrides.aiUtilService,
  };
  const conversationRepo = {
    findById: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' }),
    updateOne: jest.fn(),
  };
  const messageRepo = {
    findLatestByConversationId: jest.fn().mockResolvedValue([{ id: 'ai-msg-1', messageType: 'ai', content: 'PRD' }]),
    createOne: jest.fn().mockResolvedValue({ id: 'failure-msg' }),
    updateOne: jest.fn(),
    findMessageById: jest.fn(),
  };
  const agentsService = overrides.agentsService ?? buildMockAgentsService();
  // priorResults read artifact.content off whatever createOne resolves with, so the mock
  // must echo the persisted content back (the real repository returns the created row).
  const artifactRepository = {
    createOne: jest.fn().mockImplementation((artifact: any) => Promise.resolve({ id: 'artifact-x', ...artifact })),
    findById: jest.fn(),
    deleteOne: jest.fn(),
  };
  const stepRepository = {
    createOne: jest.fn(),
    updateOne: jest.fn(),
    findById: jest.fn(),
    findAfterOrder: jest.fn(),
    findPendingForMessage: jest.fn().mockResolvedValue([]),
  };

  const service = new AiService(
    aiUtilService as any,
    conversationRepo as any,
    messageRepo as any,
    agentsService as any,
    artifactRepository as any,
    stepRepository as any,
    {
      getAllVersions: jest.fn().mockResolvedValue([{ id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' }]),
    } as any,
    { findByMessageId: jest.fn(), createOne: jest.fn(), updateOne: jest.fn() } as any,
    { assemble: jest.fn().mockResolvedValue('App: Test app') } as any,
    { listQueryableSources: jest.fn().mockResolvedValue([]) } as any,
    {
      beginRun: jest.fn().mockResolvedValue(undefined),
      touchRun: jest.fn().mockResolvedValue(undefined),
      endRun: jest.fn().mockResolvedValue(undefined),
      findActiveRun: jest.fn().mockResolvedValue(null),
      cleanupStaleRuns: jest.fn().mockResolvedValue(0),
    } as any
  );

  return { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository };
};

const response = () =>
  ({
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    once: jest.fn(),
    flush: jest.fn(),
    flushHeaders: jest.fn(),
  }) as any;

const pendingStep = (id: string, order: number, type: string, description: string, extra: any = {}) => ({
  id,
  conversationId: 'conv-1',
  messageId: 'ai-msg-1',
  order,
  type,
  description,
  status: 'pending',
  ...extra,
});

const idColumn = {
  column_name: 'id',
  data_type: 'serial',
  is_primary_key: true,
  is_not_null: true,
  is_unique: true,
};

const customersPlannedStep = pendingStep('step-1', 0, 'CreateTable', 'Create a customers table', {
  plannedTable: {
    table_name: 'customers',
    columns: [
      idColumn,
      {
        column_name: 'name',
        data_type: 'character varying',
        is_primary_key: false,
        is_not_null: true,
        is_unique: false,
      },
    ],
  },
});

describe('AiService executeCreateTableStep — foreign-key validation (ticket #23)', () => {
  it('creates a table whose FK references a table created earlier in the same plan (planned path)', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([
      customersPlannedStep,
      pendingStep('step-2', 1, 'CreateTable', 'Create an orders table', {
        plannedTable: {
          table_name: 'orders',
          columns: [
            idColumn,
            {
              column_name: 'customer_id',
              data_type: 'integer',
              is_primary_key: false,
              is_not_null: true,
              is_unique: false,
            },
          ],
          foreign_keys: [
            {
              column_names: ['customer_id'],
              referenced_table_name: 'customers',
              referenced_column_names: ['id'],
              on_delete: 'SET NULL',
            },
          ],
        },
      }),
    ]);
    agentsService.CreateTable.mockResolvedValueOnce({
      id: 'tjdb-uuid-1',
      table_name: 'customers',
    }).mockResolvedValueOnce({ id: 'tjdb-uuid-2', table_name: 'orders' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    // No ViewTables detour: the FK target is resolved from priorResults, not the DB.
    expect(agentsService.ViewTables).not.toHaveBeenCalled();
    expect(agentsService.CreateTable).toHaveBeenNthCalledWith(2, 'org-1', {
      table_name: 'orders',
      columns: expect.any(Array),
      foreign_keys: [
        {
          column_names: ['customer_id'],
          referenced_table_name: 'customers',
          referenced_column_names: ['id'],
          on_delete: 'SET NULL',
        },
      ],
    });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(expect.anything(), 'done', { succeeded: 2, total: 2 });
  });

  it('allows an FK to reference a table that already existed before this plan (not a hallucination)', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([
      pendingStep('step-1', 0, 'CreateTable', 'Create an orders table', {
        plannedTable: {
          table_name: 'orders',
          columns: [
            idColumn,
            {
              column_name: 'customer_id',
              data_type: 'integer',
              is_primary_key: false,
              is_not_null: true,
              is_unique: false,
            },
          ],
          foreign_keys: [
            { column_names: ['customer_id'], referenced_table_name: 'customers', referenced_column_names: ['id'] },
          ],
        },
      }),
    ]);
    agentsService.ViewTables.mockResolvedValue([{ id: 'pre-existing-uuid', tableName: 'customers' }]);
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid-1', table_name: 'orders' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateTable).toHaveBeenCalledTimes(1);
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(expect.anything(), 'done', { succeeded: 1, total: 1 });
  });

  it('fails a planned-table step whose FK references a table that exists nowhere — and stops execution', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([
      pendingStep('step-1', 0, 'CreateTable', 'Create an orders table', {
        plannedTable: {
          table_name: 'orders',
          columns: [
            idColumn,
            {
              column_name: 'customer_id',
              data_type: 'integer',
              is_primary_key: false,
              is_not_null: true,
              is_unique: false,
            },
          ],
          foreign_keys: [
            { column_names: ['customer_id'], referenced_table_name: 'customres', referenced_column_names: ['id'] },
          ],
        },
      }),
    ]);

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    // The deterministic pre-flight catches the hallucinated name before any table creation.
    expect(agentsService.CreateTable).not.toHaveBeenCalled();
    const failure = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'step-failed');
    expect(failure?.[2]?.message).toContain('customres');
    expect(failure?.[2]?.message).toContain('Available tables');
  });

  it('feeds a hallucinated FK back to the LLM path so the retry can correct it', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([
      pendingStep('step-1', 0, 'CreateTable', 'Create an orders table', { plannedTable: { table_name: 'orders' } }),
    ]);
    const goodArgs = {
      table_name: 'orders',
      columns: [
        idColumn,
        {
          column_name: 'customer_id',
          data_type: 'integer',
          is_primary_key: false,
          is_not_null: true,
          is_unique: false,
        },
      ],
      foreign_keys: [
        { column_names: ['customer_id'], referenced_table_name: 'customers', referenced_column_names: ['id'] },
      ],
    };
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce({
      toolCalls: [
        {
          toolName: 'createTable',
          args: {
            ...goodArgs,
            foreign_keys: [
              { column_names: ['customer_id'], referenced_table_name: 'customres', referenced_column_names: ['id'] },
            ],
          },
        },
      ],
    }).mockResolvedValueOnce({ toolCalls: [{ toolName: 'createTable', args: goodArgs }] });
    agentsService.ViewTables.mockResolvedValue([{ id: 'pre-existing-uuid', tableName: 'customers' }]);
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid-1', table_name: 'orders' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    // The first attempt's error names what was actually available; the retry succeeds.
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(2);
    const retryUserMessage = aiUtilService.AIGatewayGenerate.mock.calls[1][2].messages[0].content;
    expect(retryUserMessage).toContain('customres');
    expect(retryUserMessage).toContain('Available tables');
    expect(agentsService.CreateTable).toHaveBeenCalledWith('org-1', expect.objectContaining({ table_name: 'orders' }));
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(expect.anything(), 'done', { succeeded: 1, total: 1 });
  });
});

describe('AiService buildTableParams — indexes (ticket #23)', () => {
  it('forwards planner-proposed indexes verbatim on the planned-table path', async () => {
    const { service, agentsService, stepRepository } = buildService();
    const indexes = [{ column_names: ['customer_id', 'status'] }, { column_names: ['email'], is_unique: true }];
    stepRepository.findPendingForMessage.mockResolvedValue([
      pendingStep('step-1', 0, 'CreateTable', 'Create an orders table', {
        plannedTable: {
          table_name: 'orders',
          columns: [
            idColumn,
            {
              column_name: 'customer_id',
              data_type: 'integer',
              is_primary_key: false,
              is_not_null: true,
              is_unique: false,
            },
          ],
          indexes,
        },
      }),
    ]);
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid-1', table_name: 'orders' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateTable).toHaveBeenCalledWith('org-1', {
      table_name: 'orders',
      columns: expect.any(Array),
      indexes,
    });
  });

  it('omits the indexes field entirely when the table proposes none', async () => {
    const { service, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([customersPlannedStep]);
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid-1', table_name: 'customers' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateTable).toHaveBeenCalledWith(
      'org-1',
      expect.not.objectContaining({ indexes: expect.anything() })
    );
  });
});
