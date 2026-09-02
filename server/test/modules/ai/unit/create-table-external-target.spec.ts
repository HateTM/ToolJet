// server/test/modules/ai/unit/create-table-external-target.spec.ts
// Ticket #77 / ADR-0042: CreateTable may target a connected PostgreSQL data source, behind
// a plan-time collision check and an execution-time confirmation gate. Mirrors the harness
// shape of create-table-fk-indexes.spec.ts.
import { AiService, resolveCreateTableTarget } from '@modules/ai/service';
import type { QueryableDataSource } from '@modules/ai/services/data-source-inventory.service';

const USER = { id: 'user-1', organizationId: 'org-1' } as any;
const PERMISSIONS = { isAdmin: true } as any;

const POSTGRES_SOURCE: QueryableDataSource = {
  id: 'ds-pg-1',
  name: 'Warehouse',
  kind: 'postgresql',
  tables: ['existing_customers'],
};

const MYSQL_SOURCE: QueryableDataSource = {
  id: 'ds-mysql-1',
  name: 'Legacy MySQL',
  kind: 'mysql',
  tables: ['orders'],
};

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
  CreateExternalTable: jest.fn(),
  SeedExternalTable: jest.fn(),
  ViewTables: jest.fn().mockResolvedValue([]),
  CreateComponent: jest.fn(),
  CreateQuery: jest.fn(),
  undoArtifact: jest.fn(),
});

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
  const artifactRepository = {
    createOne: jest.fn().mockImplementation((artifact: any) => Promise.resolve({ id: 'artifact-x', ...artifact })),
    findById: jest.fn(),
    deleteOne: jest.fn(),
  };
  const stepRepository = overrides.stepRepository ?? {
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
    { listQueryableSources: jest.fn().mockResolvedValue([POSTGRES_SOURCE]) } as any,
    {
      beginRun: jest.fn().mockResolvedValue(undefined),
      touchRun: jest.fn().mockResolvedValue(undefined),
      endRun: jest.fn().mockResolvedValue(undefined),
      findActiveRun: jest.fn().mockResolvedValue(null),
      cleanupStaleRuns: jest.fn().mockResolvedValue(0),
    } as any,
    { assess: jest.fn().mockResolvedValue({ feasible: true }) } as any
  );

  return { service, aiUtilService, agentsService, artifactRepository, stepRepository };
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

const idColumn = {
  column_name: 'id',
  data_type: 'serial',
  is_primary_key: true,
  is_not_null: true,
  is_unique: true,
};

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

describe('resolveCreateTableTarget (ticket #77 / ADR-0042, pure function)', () => {
  it('resolves to tjdb when no data_source_id is proposed', () => {
    expect(resolveCreateTableTarget(undefined, 'customers', [POSTGRES_SOURCE])).toEqual({ kind: 'tjdb' });
  });

  it('resolves to tjdb when the id names a source not shown to the planner (hallucinated id)', () => {
    expect(resolveCreateTableTarget('does-not-exist', 'customers', [POSTGRES_SOURCE])).toEqual({ kind: 'tjdb' });
  });

  it('resolves to tjdb when the named source is not postgresql — ADR-0018 stands unchanged', () => {
    expect(resolveCreateTableTarget(MYSQL_SOURCE.id, 'customers', [MYSQL_SOURCE])).toEqual({ kind: 'tjdb' });
  });

  it('resolves to collision when the proposed table name already exists in the target source', () => {
    const result = resolveCreateTableTarget(POSTGRES_SOURCE.id, 'existing_customers', [POSTGRES_SOURCE]);
    expect(result.kind).toBe('collision');
    expect((result as any).message).toContain('existing_customers');
    expect((result as any).message).toContain('Warehouse');
  });

  it('resolves to external when the target is postgresql and the name is free', () => {
    expect(resolveCreateTableTarget(POSTGRES_SOURCE.id, 'brand_new_table', [POSTGRES_SOURCE])).toEqual({
      kind: 'external',
      dataSource: POSTGRES_SOURCE,
    });
  });
});

describe('AiService executeCreateTableStep — external PostgreSQL target (ticket #77 / ADR-0042)', () => {
  it('fails a collision step at execution with no DDL attempted, on either target', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([
      pendingStep('step-1', 0, 'CreateTable', 'Create a customers table', {
        props: { collisionError: 'A table named "customers" already exists in "Warehouse".' },
      }),
    ]);

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateTable).not.toHaveBeenCalled();
    expect(agentsService.CreateExternalTable).not.toHaveBeenCalled();
    const failure = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'step-failed');
    expect(failure?.[2]?.message).toContain('customers');
  });

  it('confirms and dispatches DDL to CreateExternalTable, not CreateTable, when the gate is already confirmed', async () => {
    const { service, agentsService, stepRepository } = buildService();
    const step = pendingStep('step-1', 0, 'CreateTable', 'Create a customers table in Warehouse', {
      targetDataSourceId: POSTGRES_SOURCE.id,
      plannedTable: { table_name: 'brand_new_table', columns: [idColumn] },
    });
    stepRepository.findPendingForMessage.mockResolvedValue([step]);
    // The confirm-step endpoint already recorded 'confirmed' before the loop reaches this step.
    stepRepository.findById.mockResolvedValue({ ...step, status: 'confirmed' });
    agentsService.CreateExternalTable.mockResolvedValue({ id: POSTGRES_SOURCE.id, table_name: 'brand_new_table' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateExternalTable).toHaveBeenCalledWith(
      'org-1',
      POSTGRES_SOURCE.id,
      expect.objectContaining({ table_name: 'brand_new_table' })
    );
    expect(agentsService.CreateTable).not.toHaveBeenCalled();
  });

  it('declines and issues no DDL when the confirmation gate was skipped', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    const step = pendingStep('step-1', 0, 'CreateTable', 'Create a customers table in Warehouse', {
      targetDataSourceId: POSTGRES_SOURCE.id,
      plannedTable: { table_name: 'brand_new_table', columns: [idColumn] },
    });
    stepRepository.findPendingForMessage.mockResolvedValue([step]);
    // The user declined via skip-step before the loop reaches this step.
    stepRepository.findById.mockResolvedValue({ ...step, status: 'skipped' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateExternalTable).not.toHaveBeenCalled();
    expect(agentsService.CreateTable).not.toHaveBeenCalled();
    const skipEvent = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'step-skipped');
    expect(skipEvent).toBeDefined();
  });

  it('sends the step-awaiting-confirmation SSE event with table/columns/target/seed count before polling', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildService();
    const step = pendingStep('step-1', 0, 'CreateTable', 'Create a customers table in Warehouse', {
      targetDataSourceId: POSTGRES_SOURCE.id,
      plannedTable: { table_name: 'brand_new_table', columns: [idColumn] },
      plannedSeedRows: [{ id: 1 }, { id: 2 }],
    });
    stepRepository.findPendingForMessage.mockResolvedValue([step]);
    // Never confirmed within the timeout — keep it short via the overridable constants.
    (service as any).CONFIRMATION_POLL_INTERVAL_MS = 2;
    (service as any).CONFIRMATION_TIMEOUT_MS = 10;
    stepRepository.findById.mockResolvedValue({ ...step, status: 'pending' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    const awaiting = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'step-awaiting-confirmation');
    expect(awaiting?.[2]).toEqual(
      expect.objectContaining({
        tableName: 'brand_new_table',
        targetConnection: { id: POSTGRES_SOURCE.id, name: POSTGRES_SOURCE.name },
        seedRowCount: 2,
      })
    );
    // Never confirmed before the (very short, overridden) timeout — no DDL issued.
    expect(agentsService.CreateExternalTable).not.toHaveBeenCalled();
    const failure = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'step-failed');
    expect(failure?.[2]?.message).toContain('Timed out waiting for confirmation');
  }, 10000);

  it('inserts seed rows via SeedExternalTable, not SeedTable, on the external path', async () => {
    const { service, agentsService, stepRepository } = buildService();
    const step = pendingStep('step-1', 0, 'CreateTable', 'Create a customers table in Warehouse', {
      targetDataSourceId: POSTGRES_SOURCE.id,
      plannedTable: { table_name: 'brand_new_table', columns: [idColumn] },
      plannedSeedRows: [{ id: 1 }],
    });
    stepRepository.findPendingForMessage.mockResolvedValue([step]);
    stepRepository.findById.mockResolvedValue({ ...step, status: 'confirmed' });
    agentsService.CreateExternalTable.mockResolvedValue({ id: POSTGRES_SOURCE.id, table_name: 'brand_new_table' });
    agentsService.SeedExternalTable.mockResolvedValue({ total: 1, inserted: 1, updated: 0, failed: 0, failures: [] });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.SeedExternalTable).toHaveBeenCalledWith(
      'org-1',
      POSTGRES_SOURCE.id,
      'brand_new_table',
      step.plannedSeedRows
    );
  });

  it('leaves a ToolJet DB CreateTable step (no targetDataSourceId) on the unchanged path', async () => {
    const { service, agentsService, stepRepository } = buildService();
    stepRepository.findPendingForMessage.mockResolvedValue([
      pendingStep('step-1', 0, 'CreateTable', 'Create a customers table', {
        plannedTable: { table_name: 'customers', columns: [idColumn] },
      }),
    ]);
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid-1', table_name: 'customers' });

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    expect(agentsService.CreateTable).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ table_name: 'customers' })
    );
    expect(agentsService.CreateExternalTable).not.toHaveBeenCalled();
  });
});
