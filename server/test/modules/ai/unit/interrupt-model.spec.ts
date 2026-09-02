// server/test/modules/ai/unit/interrupt-model.spec.ts
// ADR-0044: a `select_datasource` interrupt pauses approvePrd on conversation.metadata,
// resumed by AiService.interruptAnswer. Mirrors the harness shape of
// create-table-external-target.spec.ts (ADR-0042's confirmation gate, the pattern this
// generalizes).
import { ConflictException } from '@nestjs/common';
import { AiService } from '@modules/ai/service';
import type { QueryableDataSource } from '@modules/ai/services/data-source-inventory.service';

const USER = { id: 'user-1', organizationId: 'org-1' } as any;
const PERMISSIONS = { isAdmin: true } as any;

const SOURCE_A: QueryableDataSource = { id: 'ds-a', name: 'Primary', kind: 'restapi', tables: [] };
const SOURCE_B: QueryableDataSource = { id: 'ds-b', name: 'Secondary', kind: 'restapi', tables: [] };

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
  CreateExternalTable: jest.fn(),
  SeedExternalTable: jest.fn(),
  ViewTables: jest.fn().mockResolvedValue([]),
  CreateComponent: jest.fn(),
  CreateQuery: jest.fn().mockResolvedValue({ id: 'query-1' }),
  undoArtifact: jest.fn(),
});

const buildService = (overrides: Partial<Record<string, any>> = {}) => {
  const aiUtilService = {
    AIGateway: jest.fn(),
    AIGatewayGenerate: jest.fn().mockResolvedValue({
      toolCalls: [
        {
          toolName: 'createQuery',
          args: { source: 'restapi', name: 'q1', url: '/things' },
        },
      ],
    }),
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
  const conversationRepo = overrides.conversationRepo ?? {
    findById: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate', metadata: {} }),
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
    findPendingForMessage: jest.fn().mockResolvedValue([
      {
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateQuery',
        description: 'Create a REST API query',
        status: 'pending',
      },
    ]),
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
    { listQueryableSources: jest.fn().mockResolvedValue(overrides.dataSources ?? [SOURCE_A, SOURCE_B]) } as any,
    {
      beginRun: jest.fn().mockResolvedValue(undefined),
      touchRun: jest.fn().mockResolvedValue(undefined),
      endRun: jest.fn().mockResolvedValue(undefined),
      findActiveRun: jest.fn().mockResolvedValue(null),
      cleanupStaleRuns: jest.fn().mockResolvedValue(0),
    } as any,
    { assess: jest.fn().mockResolvedValue({ feasible: true }) } as any
  );

  return { service, aiUtilService, agentsService, artifactRepository, stepRepository, conversationRepo };
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

describe('AiService — select_datasource interrupt (ADR-0044)', () => {
  it('raises an interrupt (not a retryable error) when data_source_id is omitted and multiple sources are connected', async () => {
    const { service, aiUtilService, conversationRepo } = buildService();
    (service as any).INTERRUPT_POLL_INTERVAL_MS = 2;
    (service as any).INTERRUPT_TIMEOUT_MS = 10;

    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    const interruptEvent = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'interrupt');
    expect(interruptEvent).toBeDefined();
    expect(interruptEvent?.[2]).toMatchObject({
      type: 'select_datasource',
      payload: { candidates: [{ id: 'ds-a', name: 'Primary' }, { id: 'ds-b', name: 'Secondary' }] },
    });
    // Written to conversation.metadata, not a Step column (ADR-0044's storage rationale).
    const writeCall = conversationRepo.updateOne.mock.calls.find(
      ([, patch]: any) => patch?.metadata?.interrupt?.type === 'select_datasource'
    );
    expect(writeCall).toBeDefined();
    // Times out (no answer arrives) and fails the step, not the whole process crashing.
    const failure = aiUtilService.sendSSE.mock.calls.find(([, event]) => event === 'step-failed');
    expect(failure?.[2]?.message).toContain('interrupt');
    // The stale record must not survive the timeout — a leftover interrupt would make the
    // next attempt/step reuse a dead id, skip re-sending the SSE event, and 409-collide
    // with a genuinely new pause (the bug this test guards against).
    const lastWrite = conversationRepo.updateOne.mock.calls.at(-1);
    expect(lastWrite?.[1]?.metadata?.interrupt).toBeUndefined();
  });

  it('resumes the paused step once interruptAnswer writes the chosen data source', async () => {
    let metadata: any = {};
    const conversationRepo = {
      findById: jest.fn().mockImplementation(() =>
        Promise.resolve({ id: 'conv-1', userId: 'user-1', conversationType: 'generate', metadata })
      ),
      updateOne: jest.fn().mockImplementation((_id: string, patch: any) => {
        metadata = patch.metadata;
        return Promise.resolve();
      }),
    };
    const { service, agentsService } = buildService({ conversationRepo });
    (service as any).INTERRUPT_POLL_INTERVAL_MS = 2;
    (service as any).INTERRUPT_TIMEOUT_MS = 200;

    const runPromise = service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response());

    // Answer the interrupt shortly after it's raised, the way interrupt-answer would from a
    // separate HTTP request.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const interruptId = metadata?.interrupt?.id;
    expect(interruptId).toBeDefined();
    await service.interruptAnswer('conv-1', interruptId, { dataSourceId: 'ds-b' }, 'user-1');

    await runPromise;

    expect(agentsService.CreateQuery).toHaveBeenCalledWith(
      'version-1',
      'org-1',
      expect.objectContaining({ dataSourceId: 'ds-b' })
    );
    expect(metadata.interrupt).toBeUndefined();
  });

  it('interruptAnswer rejects a stale or mismatched interruptId with 409', async () => {
    const conversationRepo = {
      findById: jest.fn().mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        conversationType: 'generate',
        metadata: { interrupt: { id: 'real-id', type: 'select_datasource', payload: {} } },
      }),
      updateOne: jest.fn(),
    };
    const { service } = buildService({ conversationRepo });

    await expect(
      service.interruptAnswer('conv-1', 'wrong-id', { dataSourceId: 'ds-b' }, 'user-1')
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('interruptAnswer rejects when no interrupt is currently live', async () => {
    const conversationRepo = {
      findById: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate', metadata: {} }),
      updateOne: jest.fn(),
    };
    const { service } = buildService({ conversationRepo });

    await expect(
      service.interruptAnswer('conv-1', 'any-id', { dataSourceId: 'ds-b' }, 'user-1')
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
