// server/test/modules/ai/unit/service.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiService } from '@modules/ai/service';

// approvePrd takes the acting user, not just their organization id: assembling the connected
// data sources (ADR-0019) goes through the same connector plumbing a query run does, which
// resolves the source's options against the user.
const USER = { id: 'user-1', organizationId: 'org-1' } as any;
// The connected sources are read through the same permission-filtered listing the data source
// panel uses, so approvePrd carries the caller's permissions as well as their identity.
const PERMISSIONS = { isAdmin: true } as any;

const buildMockAiUtilService = () => ({
  AIGateway: jest.fn(),
  AIGatewayGenerate: jest.fn(),
  sendSSE: jest.fn(),
  initSSE: jest.fn(),
  startHeartbeat: jest.fn(),
  createNewConversation: jest.fn(),
  getConversationsList: jest.fn(),
  getConversationById: jest.fn(),
  estimateTokenCount: jest.fn().mockReturnValue(0),
  getContextWindow: jest.fn().mockReturnValue(128_000),
  fitMessagesToContextWindow: jest.fn().mockImplementation((msgs) => ({ messages: msgs, truncated: [] })),
  fitMessagesToContextWindowForOrg: jest
    .fn()
    .mockImplementation((_orgId: string, msgs: any[]) => ({ messages: msgs, truncated: [] })),
});

const buildMockAiActiveRunService = () => ({
  beginRun: jest.fn().mockResolvedValue({ conversationId: 'conv-1' }),
  touchRun: jest.fn().mockResolvedValue(undefined),
  endRun: jest.fn().mockResolvedValue(undefined),
  findActiveRun: jest.fn().mockResolvedValue(null),
  cleanupStaleRuns: jest.fn().mockResolvedValue(0),
});

// Defaults to a Generate conversation so the tests that don't care about the type (most of
// them) don't each have to say so; Learn-conversation tests override `findById` themselves.
const buildMockConversationRepository = () => ({
  findById: jest.fn().mockResolvedValue({
    id: 'conversation-1',
    appId: 'app-1',
    conversationType: 'generate',
    // Ownership is enforced on every conversation-scoped entry point; the default mock
    // belongs to 'user-1' so default-based tests (which act as user-1) pass without each
    // re-specifying it. Tests acting as another user override findById themselves.
    userId: 'user-1',
  }),
  updateOne: jest.fn(),
});

const buildMockAppInventoryService = () => ({
  assemble: jest.fn().mockResolvedValue('App: Test app'),
});

const buildMockAiFeasibilityService = () => ({
  assess: jest.fn().mockReturnValue({ type: 'feasible' }),
});

// Defaults to "engine not configured" (GENERATION_ENGINE_URL unset) — every pre-#91 test's
// world, and the flag-guarded fallback path (ADR-0035): sendUserMessage keeps using
// aiUtilService.AIGateway unless a test explicitly opts into the engine.
const buildMockGenerationEngineClient = () => ({
  isConfigured: jest.fn().mockReturnValue(false),
  streamPrd: jest.fn(),
});

// Defaults to "nothing external connected", which is every pre-ADR-0019 test's world: the
// plan targets ToolJet DB and no data-source block reaches any prompt.
const buildMockDataSourceInventoryService = () => ({
  listQueryableSources: jest.fn().mockResolvedValue([]),
});

const buildMockMessageRepository = () => ({
  findLatestByConversationId: jest.fn(),
  createOne: jest.fn(),
  updateOne: jest.fn(),
  findMessageById: jest.fn(),
});

const buildMockAiResponseVoteRepository = () => ({
  findByMessageId: jest.fn(),
  createOne: jest.fn(),
  updateOne: jest.fn(),
});

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
  CreateComponent: jest.fn(),
  CreateQuery: jest.fn(),
  undoArtifact: jest.fn(),
});

const buildMockArtifactRepository = () => ({
  createOne: jest.fn(),
  findById: jest.fn(),
  deleteOne: jest.fn(),
});

const buildMockStepRepository = () => ({
  createOne: jest.fn(),
  updateOne: jest.fn(),
  findById: jest.fn(),
  findAfterOrder: jest.fn(),
  // Defaults to "no pending plan" so every pre-#20 test falls through to a fresh
  // generateStepPlan, exactly as before.
  findPendingForMessage: jest.fn().mockResolvedValue([]),
});

// Defaults to one version so tests that don't care about appVersionId resolution (most of
// them) don't all have to mock it individually; tests that do care override it. createdAt
// is set explicitly (not left undefined) since resolveAppVersionId sorts by it.
const buildMockVersionRepository = () => ({
  getAllVersions: jest.fn().mockResolvedValue([{ id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' }]),
});

const buildMockResponse = () => {
  const closeHandlers: Array<() => void> = [];
  const response = {
    setHeader: jest.fn(),
    write: jest.fn(),
    flush: jest.fn(),
    flushHeaders: jest.fn(),
    end: jest.fn(() => {
      closeHandlers.forEach((handler) => handler());
    }),
    once: jest.fn((event: string, handler: () => void) => {
      if (event === 'close' || event === 'finish') {
        closeHandlers.push(handler);
      }
    }),
  };
  return response;
};

// Builds an AiService with all 12 constructor dependencies mocked, any of which can be
// overridden. Centralizing this avoids repeating the full mock/constructor wiring in
// every test (and having to update all of them whenever the constructor's shape changes).
const buildService = (overrides: Partial<Record<string, any>> = {}) => {
  const aiUtilService = overrides.aiUtilService ?? buildMockAiUtilService();
  const conversationRepo = overrides.conversationRepo ?? buildMockConversationRepository();
  const messageRepo = overrides.messageRepo ?? buildMockMessageRepository();
  const agentsService = overrides.agentsService ?? buildMockAgentsService();
  const artifactRepository = overrides.artifactRepository ?? buildMockArtifactRepository();
  const stepRepository = overrides.stepRepository ?? buildMockStepRepository();
  const versionRepository = overrides.versionRepository ?? buildMockVersionRepository();
  const aiResponseVoteRepository = overrides.aiResponseVoteRepository ?? buildMockAiResponseVoteRepository();
  const appInventoryService = overrides.appInventoryService ?? buildMockAppInventoryService();
  const dataSourceInventoryService = overrides.dataSourceInventoryService ?? buildMockDataSourceInventoryService();
  const aiActiveRunService = overrides.aiActiveRunService ?? buildMockAiActiveRunService();
  const aiFeasibilityService = overrides.aiFeasibilityService ?? buildMockAiFeasibilityService();
  const generationEngineClient = overrides.generationEngineClient ?? buildMockGenerationEngineClient();

  const service = new AiService(
    aiUtilService as any,
    conversationRepo as any,
    messageRepo as any,
    agentsService as any,
    artifactRepository as any,
    stepRepository as any,
    versionRepository as any,
    aiResponseVoteRepository as any,
    appInventoryService as any,
    dataSourceInventoryService as any,
    aiActiveRunService as any,
    aiFeasibilityService as any,
    generationEngineClient as any
  );

  return {
    service,
    aiUtilService,
    conversationRepo,
    messageRepo,
    agentsService,
    artifactRepository,
    stepRepository,
    versionRepository,
    aiResponseVoteRepository,
    appInventoryService,
    dataSourceInventoryService,
    aiActiveRunService,
    aiFeasibilityService,
    generationEngineClient,
  };
};

/** @group platform */
describe('AiService.getCreditsBalance', () => {
  it('returns an enabled/unlimited result with no error, for any organization', async () => {
    const { service } = buildService();

    const result = await service.getCreditsBalance('org-1');

    expect(result).toEqual({ aiFeaturesEnabled: true });
    expect(result.error).toBeUndefined();
  });

  it('does not read any credit-history repository (self-hosted CE has no credit accounting)', async () => {
    const { service } = buildService();

    await expect(service.getCreditsBalance('org-2')).resolves.toEqual({ aiFeaturesEnabled: true });
  });
});

/** @group platform */
describe('AiService.sendUserMessage', () => {
  it('streams chunks over SSE and persists the final AI message on success', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne
      .mockResolvedValueOnce({ id: 'user-msg-1' })
      .mockResolvedValueOnce({ id: 'ai-msg-1', content: 'Hello world' });

    async function* chunks() {
      yield 'Hello ';
      yield 'world';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiUtilService.AIGateway).toHaveBeenCalledWith(
      'openai',
      'send-message',
      {
        messages: [
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: 'Hi' },
        ],
      },
      'org-1'
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'chunk', { content: 'Hello ' });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'chunk', { content: 'world' });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
      message: { id: 'ai-msg-1', content: 'Hello world' },
    });

    expect(messageRepo.createOne).toHaveBeenNthCalledWith(1, {
      aiConversationId: 'conv-1',
      messageType: 'user',
      content: 'Hi',
      references: null,
      isLatest: true,
    });
    expect(messageRepo.createOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        aiConversationId: 'conv-1',
        messageType: 'ai',
        content: 'Hello world',
        parentId: 'user-msg-1',
        isLatest: true,
      })
    );

    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('initializes the SSE stream and starts a heartbeat for an active stream', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });
    aiUtilService.AIGateway.mockResolvedValue({ textStream: (async function* () {})() });

    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiUtilService.initSSE).toHaveBeenCalledWith(response);
    expect(aiUtilService.startHeartbeat).toHaveBeenCalledWith(response);
  });

  it('registers an active run at stream start and ends it when the stream finishes', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, aiActiveRunService } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });
    aiUtilService.AIGateway.mockResolvedValue({ textStream: (async function* () {})() });

    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiActiveRunService.beginRun).toHaveBeenCalledWith('conv-1', 'user-1', 'org-1');
    expect(aiActiveRunService.endRun).toHaveBeenCalledWith('conv-1');
  });

  it('ends the active run even when the stream fails', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, aiActiveRunService } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValue({ id: 'user-msg-1' });
    aiUtilService.AIGateway.mockRejectedValue(new Error('LLM gateway timed out'));

    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiActiveRunService.endRun).toHaveBeenCalledWith('conv-1');
  });

  it('grounds every request in a PRD-focused system prompt (Generate conversations only ever propose a PRD, never build)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });

    async function* chunks() {
      yield 'ok';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    await service.sendUserMessage(
      { conversationId: 'conv-1', content: 'Build me a CRM' },
      buildMockResponse() as any,
      'user-1',
      'org-1'
    );

    const [, , promptBody] = aiUtilService.AIGateway.mock.calls[0];
    expect(promptBody.messages[0]).toEqual({ role: 'system', content: expect.stringContaining('PRD') });
    expect(promptBody.messages[0].content).toContain('Product Requirements Document');
  });

  it('includes prior conversation history (as role-mapped messages) before the new message', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { messageType: 'user', content: 'first message' },
      { messageType: 'ai', content: 'first reply' },
    ]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-2' }).mockResolvedValueOnce({ id: 'ai-msg-2' });

    async function* chunks() {
      yield 'ok';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    await service.sendUserMessage(
      { conversationId: 'conv-1', content: 'follow up' },
      buildMockResponse() as any,
      'user-1',
      'org-1'
    );

    expect(aiUtilService.AIGateway).toHaveBeenCalledWith(
      'openai',
      'send-message',
      {
        messages: [
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: 'first message' },
          { role: 'assistant', content: 'first reply' },
          { role: 'user', content: 'follow up' },
        ],
      },
      'org-1'
    );
  });

  it('throws BadRequestException when conversationId or content is missing, before touching any repository', async () => {
    const { service, conversationRepo } = buildService();

    await expect(
      service.sendUserMessage(
        { conversationId: '', content: 'hi' } as any,
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toThrow(BadRequestException);

    expect(conversationRepo.findById).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(
      service.sendUserMessage(
        { conversationId: 'conv-x', content: 'hi' },
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toThrow(NotFoundException);
  });

  it('sends an SSE error event and ends the response when the AI gateway fails mid-stream', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValue({ id: 'user-msg-1' });
    aiUtilService.AIGateway.mockRejectedValue(new Error('LLM gateway timed out'));

    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', { message: 'LLM gateway timed out' });
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  // Ticket #91: when GENERATION_ENGINE_URL is configured, sendUserMessage proxies the
  // Generation engine's SSE stream instead of calling AIGateway in-process (ADR-0027).
  describe('proxying the Generation engine (ticket #91)', () => {
    it('forwards engine chunk events over SSE and never calls AIGateway', async () => {
      const { service, aiUtilService, conversationRepo, messageRepo, generationEngineClient } = buildService();
      generationEngineClient.isConfigured.mockReturnValue(true);
      conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
      messageRepo.findLatestByConversationId.mockResolvedValue([]);
      messageRepo.createOne
        .mockResolvedValueOnce({ id: 'user-msg-1' })
        .mockResolvedValueOnce({ id: 'ai-msg-1', content: 'Hello world' });

      async function* events() {
        yield { type: 'chunk', content: 'Hello ' };
        yield { type: 'chunk', content: 'world' };
        yield { type: 'done' };
      }
      generationEngineClient.streamPrd.mockReturnValue(events());

      const response = buildMockResponse();
      await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

      expect(aiUtilService.AIGateway).not.toHaveBeenCalled();
      expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'chunk', { content: 'Hello ' });
      expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'chunk', { content: 'world' });

      // The server, not the engine, owns persistence and the browser-facing `done` — a
      // GenerationEngineClient 'done' event must never pass through verbatim, since it
      // carries no persisted message.
      expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
        message: { id: 'ai-msg-1', content: 'Hello world' },
      });
      expect(messageRepo.createOne).toHaveBeenNthCalledWith(2, expect.objectContaining({ content: 'Hello world' }));
    });

    it('maps a GenerationEngineClient error event onto the existing error SSE contract', async () => {
      const { service, aiUtilService, conversationRepo, messageRepo, generationEngineClient } = buildService();
      generationEngineClient.isConfigured.mockReturnValue(true);
      conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
      messageRepo.findLatestByConversationId.mockResolvedValue([]);
      messageRepo.createOne.mockResolvedValue({ id: 'user-msg-1' });

      async function* events() {
        yield { type: 'chunk', content: 'partial' };
        yield { type: 'error', message: 'Generation engine stream ended unexpectedly' };
      }
      generationEngineClient.streamPrd.mockReturnValue(events());

      const response = buildMockResponse();
      await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

      expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', {
        message: 'Generation engine stream ended unexpectedly',
      });
      // A truncated stream must not be persisted as a successful reply (AC#3).
      expect(messageRepo.createOne).toHaveBeenCalledTimes(1);
      expect(response.end).toHaveBeenCalledTimes(1);
    });

    it('passes an AbortSignal to the engine client (wired to the response close handler)', async () => {
      const { service, conversationRepo, messageRepo, generationEngineClient } = buildService();
      generationEngineClient.isConfigured.mockReturnValue(true);
      conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
      messageRepo.findLatestByConversationId.mockResolvedValue([]);
      messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });

      async function* events() {
        yield { type: 'chunk', content: 'x' };
        yield { type: 'done' };
      }
      generationEngineClient.streamPrd.mockReturnValue(events());

      await service.sendUserMessage(
        { conversationId: 'conv-1', content: 'Hi' },
        buildMockResponse() as any,
        'user-1',
        'org-1'
      );

      expect(generationEngineClient.streamPrd).toHaveBeenCalledWith(expect.any(Array), expect.any(AbortSignal));
    });
  });

  // IDOR regression (CRITICAL): a conversation must belong to the acting user even when its
  // UUID is known — otherwise any user could read/mutate another user's thread.
  it('404s when the conversation belongs to another user (ownership enforced)', async () => {
    const { service, conversationRepo, messageRepo, aiUtilService } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-2',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    aiUtilService.AIGateway.mockResolvedValue({ textStream: (async function* () {})() });

    await expect(
      service.sendUserMessage(
        { conversationId: 'conv-1', content: 'Hi' },
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toThrow(NotFoundException);
    expect(messageRepo.createOne).not.toHaveBeenCalled();
  });

  it('fits the assembled prompt to the model context window before sending it to the gateway', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });

    const budgetedMessages = [
      { role: 'system', content: 'truncated system' },
      { role: 'user', content: 'Hi' },
    ];
    aiUtilService.fitMessagesToContextWindowForOrg.mockReturnValue({ messages: budgetedMessages, truncated: [{}] });
    aiUtilService.AIGateway.mockResolvedValue({ textStream: (async function* () {})() });

    await service.sendUserMessage(
      { conversationId: 'conv-1', content: 'Hi' },
      buildMockResponse() as any,
      'user-1',
      'org-1'
    );

    expect(aiUtilService.fitMessagesToContextWindowForOrg).toHaveBeenCalledWith(
      'org-1',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: 'Hi' }),
      ])
    );
    expect(aiUtilService.AIGateway).toHaveBeenCalledWith(
      'openai',
      'send-message',
      { messages: budgetedMessages },
      'org-1'
    );
  });

  it('assembles the app inventory and asks the feasibility service before calling the LLM', async () => {
    const { service, conversationRepo, messageRepo, appInventoryService, aiFeasibilityService, aiUtilService } =
      buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
      appId: 'app-1',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValue({ id: 'user-msg-1' });
    appInventoryService.assemble.mockResolvedValue('App: CRM\n\nPages:\n- Home');
    aiUtilService.AIGateway.mockResolvedValue({ textStream: (async function* () {})() });

    await service.sendUserMessage(
      { conversationId: 'conv-1', content: 'Build a CRM', references: [{ type: 'page', id: 'p1', name: 'Home' }] },
      buildMockResponse() as any,
      'user-1',
      'org-1'
    );

    expect(appInventoryService.assemble).toHaveBeenCalledWith('app-1', 'version-1');
    expect(aiFeasibilityService.assess).toHaveBeenCalledWith(
      'Build a CRM',
      'App: CRM\n\nPages:\n- Home',
      expect.arrayContaining([expect.objectContaining({ name: 'Home' })])
    );
  });

  it('returns an infeasible request as a normal AI message without calling the LLM', async () => {
    const { service, conversationRepo, messageRepo, appInventoryService, aiFeasibilityService, aiUtilService } =
      buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
      appId: 'app-1',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne
      .mockResolvedValueOnce({ id: 'user-msg-1' })
      .mockResolvedValueOnce({ id: 'ai-msg-1', content: 'I could not find that page.' });
    appInventoryService.assemble.mockResolvedValue('App: CRM');
    aiFeasibilityService.assess.mockReturnValue({
      type: 'infeasible',
      messageForUser: 'I could not find that page.',
    });

    const response = buildMockResponse();
    await service.sendUserMessage(
      { conversationId: 'conv-1', content: 'Add a button to the Dashboard page' },
      response as any,
      'user-1',
      'org-1'
    );

    expect(aiUtilService.AIGateway).not.toHaveBeenCalled();
    expect(messageRepo.createOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        aiConversationId: 'conv-1',
        messageType: 'ai',
        content: 'I could not find that page.',
        parentId: 'user-msg-1',
        metadata: { feasibility: { type: 'infeasible', messageForUser: 'I could not find that page.' } },
      })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
      message: { id: 'ai-msg-1', content: 'I could not find that page.' },
    });
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('returns a noData response as a normal AI message without calling the LLM', async () => {
    const { service, conversationRepo, messageRepo, appInventoryService, aiFeasibilityService, aiUtilService } =
      buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
      appId: 'app-1',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });
    appInventoryService.assemble.mockResolvedValue('App: CRM');
    aiFeasibilityService.assess.mockReturnValue({
      type: 'noData',
      recommendations: ['Try describing an app you want to build.'],
    });

    const response = buildMockResponse();
    await service.sendUserMessage({ conversationId: 'conv-1', content: 'hi' }, response as any, 'user-1', 'org-1');

    expect(aiUtilService.AIGateway).not.toHaveBeenCalled();
    expect(messageRepo.createOne).toHaveBeenLastCalledWith(
      expect.objectContaining({
        aiConversationId: 'conv-1',
        messageType: 'ai',
        metadata: {
          feasibility: { type: 'noData', recommendations: ['Try describing an app you want to build.'] },
        },
      })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', expect.any(Object));
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});

/** @group platform */
describe('AiService conversation delegation', () => {
  it('createConversation delegates to AiUtilService.createNewConversation', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.createNewConversation.mockResolvedValue({ id: 'conv-1' });

    const result = await service.createConversation('user-1', 'app-1', 'generate', 'org-1', 'conv-0', true);

    expect(aiUtilService.createNewConversation).toHaveBeenCalledWith('user-1', 'app-1', 'generate', 'conv-0', true);
    expect(result).toEqual({ id: 'conv-1' });
  });

  it('listConversations delegates to AiUtilService.getConversationsList', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.getConversationsList.mockResolvedValue([{ id: 'conv-1' }]);

    const result = await service.listConversations('app-1', 'user-1', 'generate');

    expect(aiUtilService.getConversationsList).toHaveBeenCalledWith('app-1', 'user-1', 'generate');
    expect(result).toEqual([{ id: 'conv-1' }]);
  });

  it('getConversationById delegates to AiUtilService.getConversationById', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.getConversationById.mockResolvedValue({ id: 'conv-1', messages: [] });

    const result = await service.getConversationById('conv-1', 'user-1');

    expect(aiUtilService.getConversationById).toHaveBeenCalledWith('conv-1', 'user-1');
    expect(result).toEqual({ id: 'conv-1', messages: [] });
  });
});

/** @group platform */
describe('AiService.approvePrd', () => {
  const planToolCall = (steps: Array<{ type: string; description: string }>) => ({
    toolCalls: [{ toolName: 'proposeStepPlan', args: { steps } }],
  });

  const createTableToolCall = (args: any) => ({
    toolCalls: [{ toolName: 'createTable', args }],
  });

  const oneColumnTable = (table_name: string) => ({
    table_name,
    columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
  });

  // The row generateStepPlan persists per proposed step — the same seven fields recur in
  // every multi-step test's stepRepository.createOne mocks.
  const pendingStep = (id: string, order: number, type: string, description: string) => ({
    id,
    conversationId: 'conv-1',
    messageId: 'ai-msg-1',
    order,
    type,
    description,
    status: 'pending',
  });

  it('generates a step plan, persists Steps in order, and executes a single CreateTable step end to end', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    messageRepo.createOne.mockResolvedValue({ id: 'failure-msg' }); // unused on the success path

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateTable', description: 'Create a customers table' }])
    ).mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')));

    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateTable',
      description: 'Create a customers table',
      status: 'pending',
    });

    // What executeCreateTableStep maps oneColumnTable('customers') into before handing it to
    // AgentsService — and, merged onto the created table, what it persists as content.
    const customersColumns = [
      {
        column_name: 'id',
        data_type: 'serial',
        constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
      },
    ];

    // AgentsService.CreateTable only ever returns { id, table_name } — no columns.
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers', columns: customersColumns },
      identifier: 'customers',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    expect(stepRepository.createOne).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateTable',
      description: 'Create a customers table',
      status: 'pending',
    });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'plan', {
      steps: [{ id: 'step-1', type: 'CreateTable', description: 'Create a customers table' }],
    });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'step-progress', {
      step: 1,
      of: 1,
      description: 'Create a customers table',
    });

    expect(agentsService.CreateTable).toHaveBeenCalledWith('org-1', {
      table_name: 'customers',
      columns: customersColumns,
    });
    // The persisted content is the created table *merged with the columns just requested* —
    // AgentsService returns only { id, table_name }, so without this merge later steps
    // (CreateQuery, and a Form step's field generation) would read this table's schema back
    // out of context.priorResults as undefined.
    expect(artifactRepository.createOne).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers', columns: customersColumns },
      identifier: 'customers',
    });
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'succeeded', attempts: 1, artifactId: 'artifact-1' })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'step-done',
      expect.objectContaining({ step: 1, of: 1 })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', { succeeded: 1, total: 1 });
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('retries a failing step and succeeds on a later attempt, telling the retry what went wrong', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateTable', description: 'Create a customers table' }])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers_v2')));

    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateTable',
      description: 'Create a customers table',
      status: 'pending',
    });

    agentsService.CreateTable.mockRejectedValueOnce(new Error('Table with name "customers" already exists'));
    agentsService.CreateTable.mockResolvedValueOnce({ id: 'tjdb-uuid', table_name: 'customers_v2' });
    artifactRepository.createOne.mockResolvedValue({ id: 'artifact-1', identifier: 'customers_v2' });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    expect(agentsService.CreateTable).toHaveBeenCalledTimes(2);
    // The retry's per-step call is told what the previous attempt's error was.
    const secondCallPromptBody = aiUtilService.AIGatewayGenerate.mock.calls[2][2];
    expect(secondCallPromptBody.messages[0].content).toContain('already exists');
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', { succeeded: 1, total: 1 });
  });

  it('stops after exhausting retries, keeps prior succeeded Artifacts, and posts a failure message', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    messageRepo.createOne.mockResolvedValue({ id: 'failure-msg-1' });

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateTable', description: 'Create an orders table' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      // 3 attempts for the second step, all fail
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('orders')))
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('orders')))
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('orders')));

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateTable',
        description: 'Create an orders table',
        status: 'pending',
      });

    agentsService.CreateTable.mockResolvedValueOnce({ id: 'tjdb-uuid-1', table_name: 'customers' }).mockRejectedValue(
      new Error('ToolJet DB is unavailable')
    );

    artifactRepository.createOne.mockResolvedValue({ id: 'artifact-1', identifier: 'customers' });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    // Retried exactly MAX_STEP_ATTEMPTS (3) times for the failing step, on top of the one
    // successful call for the first step.
    expect(agentsService.CreateTable).toHaveBeenCalledTimes(4);
    // Only the succeeded first step produced an Artifact — the failed step never did.
    expect(artifactRepository.createOne).toHaveBeenCalledTimes(1);
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-2',
      expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('unavailable') })
    );
    expect(messageRepo.createOne).toHaveBeenCalledWith(
      expect.objectContaining({
        aiConversationId: 'conv-1',
        messageType: 'ai',
        content: expect.stringContaining('step 2 of 2'),
        parentId: 'ai-msg-1',
      })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'step-failed',
      expect.objectContaining({ step: 2, of: 2 })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'done',
      expect.objectContaining({ succeeded: 1, total: 2, message: { id: 'failure-msg-1' } })
    );
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('fails a step whose type has no handler immediately, without spending any retries on it (ADR-0006 defense-in-depth — all v1 STEP_TYPES have handlers as of this ticket, so this exercises the guard directly rather than a reachable-via-the-planner path)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    messageRepo.createOne.mockResolvedValue({ id: 'failure-msg' });

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      // The mock stands in for the LLM, so it can return a type outside STEP_TYPES even
      // though the real zod schema wouldn't let the model do this — verifying the
      // SUPPORTED_STEP_TYPES guard itself still holds if that ever changes.
      planToolCall([{ type: 'CreateWorkflow', description: 'Run a workflow' }])
    );
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateWorkflow',
      description: 'Run a workflow',
      status: 'pending',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    // Only the plan-generation call happened — no per-step LLM call or agentsService call
    // for a step type with no handler at all.
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(1);
    expect(agentsService.CreateTable).not.toHaveBeenCalled();
    expect(agentsService.CreateComponent).not.toHaveBeenCalled();
    expect(agentsService.CreateQuery).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('Unsupported step type') })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'step-failed', expect.objectContaining({ step: 1 }));
  });

  it('throws BadRequestException when conversationId or prd is missing', async () => {
    const { service, conversationRepo } = buildService();

    await expect(service.approvePrd('', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any)).rejects.toThrow(
      BadRequestException
    );
    expect(conversationRepo.findById).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(
      service.approvePrd('conv-x', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any)
    ).rejects.toThrow(NotFoundException);
  });

  it('sends an SSE error event when the plan-generation call fails', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    aiUtilService.AIGatewayGenerate.mockRejectedValue(new Error('LLM gateway timed out'));

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'error',
      expect.objectContaining({ message: expect.any(String) })
    );
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  const componentToolCall = (args: any) => ({ toolCalls: [{ toolName: 'createComponent', args }] });
  const queryToolCall = (args: any) => ({ toolCalls: [{ toolName: 'createQuery', args }] });

  it('resolves appVersionId from the conversation.appId (VersionRepository.getAllVersions, first version) and creates a Page component', async () => {
    const {
      service,
      aiUtilService,
      conversationRepo,
      messageRepo,
      agentsService,
      artifactRepository,
      stepRepository,
      versionRepository,
    } = buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    versionRepository.getAllVersions.mockResolvedValue([
      { id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'version-2', createdAt: '2026-02-01T00:00:00.000Z' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateComponent', description: 'Create the Orders page' }])
    ).mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Orders' }));

    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateComponent',
      description: 'Create the Orders page',
      status: 'pending',
    });
    agentsService.CreateComponent.mockResolvedValue({ id: 'page-1', name: 'Orders' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      content: { id: 'page-1', name: 'Orders' },
      identifier: 'page-1',
    });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(versionRepository.getAllVersions).toHaveBeenCalledWith('app-1');
    expect(agentsService.CreateComponent).toHaveBeenCalledWith('version-1', 'org-1', 'Page', { name: 'Orders' });
    expect(artifactRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({ content: { id: 'page-1', name: 'Orders' }, identifier: 'page-1' })
    );
  });

  it('picks the earliest-created version even when VersionRepository.getAllVersions returns them out of order', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository, versionRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    // Deliberately reversed / unordered — getAllVersions itself doesn't sort.
    versionRepository.getAllVersions.mockResolvedValue([
      { id: 'version-newest', createdAt: '2026-03-01T00:00:00.000Z' },
      { id: 'version-oldest', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'version-middle', createdAt: '2026-02-01T00:00:00.000Z' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateComponent', description: 'Create the Orders page' }])
    ).mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Orders' }));
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateComponent',
      description: 'Create the Orders page',
      status: 'pending',
    });
    agentsService.CreateComponent.mockResolvedValue({ id: 'page-1', name: 'Orders' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateComponent).toHaveBeenCalledWith('version-oldest', 'org-1', 'Page', { name: 'Orders' });
  });

  it('creates a query from a CreateQuery step', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository } = buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List orders' }])
    ).mockResolvedValueOnce(queryToolCall({ name: 'list_orders', table_id: 'table-uuid' }));

    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateQuery',
      description: 'List orders',
      status: 'pending',
    });
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_orders' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).toHaveBeenCalledWith('version-1', 'org-1', {
      name: 'list_orders',
      options: { operation: 'list_rows', table_id: 'table-uuid', list_rows: { limit: 100 } },
    });
  });

  it('retries an unrecognized component type (the model can self-correct, unlike an unsupported Step type)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateComponent', description: 'Create a page' }])
    )
      // 'Calendar' is deliberately outside SUPPORTED_COMPONENT_TYPES — a plausible thing for
      // the model to reach for, and not something this build can create. If it ever joins the
      // allow-list, the errorMessage assertion below fails loudly rather than this attempt
      // quietly falling through to some later validation (which is how 'Form' rotted this
      // test — and how 'Chart' did, until ticket #13 added it).
      .mockResolvedValueOnce(componentToolCall({ type: 'Calendar', name: 'x' }))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Orders' }));

    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateComponent',
      description: 'Create a page',
      status: 'pending',
    });
    agentsService.CreateComponent.mockResolvedValue({ id: 'page-1', name: 'Orders' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      content: { id: 'page-1', name: 'Orders' },
      identifier: 'page-1',
    });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // Only called once — the first (Calendar) attempt never reached AgentsService at all.
    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(1);
    expect(agentsService.CreateComponent).toHaveBeenCalledWith('version-1', 'org-1', 'Page', { name: 'Orders' });
    // Attempt 1 was rejected for the type itself, not for anything downstream of it.
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({
        attempts: 1,
        errorMessage: expect.stringContaining('Unsupported component type "Calendar"'),
      })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });

  it('rejects a Table step whose pageId does not match any Page created in this plan, then succeeds once the retry references the real one', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateComponent', description: 'Create the Orders page' },
        { type: 'CreateQuery', description: 'List orders' },
        { type: 'CreateComponent', description: 'Add a table of orders to the page' },
      ])
    )
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Orders' }))
      .mockResolvedValueOnce(queryToolCall({ name: 'list_orders', table_id: 'tjdb-orders-uuid' }))
      // Attempt 1: hallucinated pageId that doesn't match the real Page artifact below.
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Table', pageId: 'made-up-page-id', title: 'Orders', queryName: 'list_orders' })
      )
      // Attempt 2 (retry): the real pageId.
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Table', pageId: 'page-1', title: 'Orders', queryName: 'list_orders' })
      );

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateComponent',
        description: 'Create the Orders page',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateQuery',
        description: 'List orders',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-3',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 2,
        type: 'CreateComponent',
        description: 'Add a table of orders to the page',
        status: 'pending',
      });

    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Orders' }).mockResolvedValueOnce({
      id: 'component-1',
      pageId: 'page-1',
      type: 'Table',
      queryName: 'list_orders',
    });
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_orders' });

    // Real content is what the retry-vs-hallucination check reads from priorResults, so
    // each succeeded step's Artifact needs its actual content, not a bare mock default.
    artifactRepository.createOne
      .mockResolvedValueOnce({ id: 'artifact-1', content: { id: 'page-1', name: 'Orders' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-2',
        content: { id: 'query-1', name: 'list_orders' },
        identifier: 'list_orders',
      })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'component-1', pageId: 'page-1', type: 'Table', queryName: 'list_orders' },
        identifier: 'component-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // CreateComponent is called twice total: once for the Page, once for the Table's
    // successful (second) attempt — the hallucinated-pageId attempt never reached it.
    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(2);
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(2, 'version-1', 'org-1', 'Table', {
      pageId: 'page-1',
      title: 'Orders',
      queryName: 'list_orders',
    });
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-3',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });

  it('builds a working page end to end: CreateTable → CreateComponent(Page) → CreateQuery → CreateComponent(Table), each step referencing the real prior artifacts', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD: build me an app to track orders' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create an orders table' },
        { type: 'CreateComponent', description: 'Create the Orders page' },
        { type: 'CreateQuery', description: 'List orders' },
        { type: 'CreateComponent', description: 'Add a table of orders to the page' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('orders')))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Orders' }))
      .mockResolvedValueOnce(queryToolCall({ name: 'list_orders', table_id: 'tjdb-orders-uuid' }))
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Table', pageId: 'page-1', title: 'Orders', queryName: 'list_orders' })
      );

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create an orders table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateComponent',
        description: 'Create the Orders page',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-3',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 2,
        type: 'CreateQuery',
        description: 'List orders',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-4',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 3,
        type: 'CreateComponent',
        description: 'Add a table of orders to the page',
        status: 'pending',
      });

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-orders-uuid', table_name: 'orders' });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Orders' }).mockResolvedValueOnce({
      id: 'component-1',
      pageId: 'page-1',
      type: 'Table',
      queryName: 'list_orders',
    });
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_orders' });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-orders-uuid', table_name: 'orders' },
        identifier: 'orders',
      })
      .mockResolvedValueOnce({ id: 'artifact-2', content: { id: 'page-1', name: 'Orders' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'query-1', name: 'list_orders' },
        identifier: 'list_orders',
      })
      .mockResolvedValueOnce({
        id: 'artifact-4',
        content: { id: 'component-1', pageId: 'page-1', type: 'Table', queryName: 'list_orders' },
        identifier: 'component-1',
      });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD: build me an app to track orders', USER, PERMISSIONS, response as any);

    // The CreateQuery step's prompt includes the real table id CreateTable produced.
    const queryStepPromptBody = aiUtilService.AIGatewayGenerate.mock.calls[3][2];
    expect(queryStepPromptBody.messages[0].content).toContain('tjdb-orders-uuid');

    // The final CreateComponent(Table) step's prompt includes the real Page id and query name.
    const tableStepPromptBody = aiUtilService.AIGatewayGenerate.mock.calls[4][2];
    expect(tableStepPromptBody.messages[0].content).toContain('page-1');
    expect(tableStepPromptBody.messages[0].content).toContain('list_orders');

    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(2, 'version-1', 'org-1', 'Table', {
      pageId: 'page-1',
      title: 'Orders',
      queryName: 'list_orders',
    });

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', { succeeded: 4, total: 4 });
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it("a CreateTable step's Artifact content includes the table's real columns (not just id/table_name)", async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateTable', description: 'Create an orders table' }])
    ).mockResolvedValueOnce(createTableToolCall(oneColumnTable('orders')));
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateTable',
      description: 'Create an orders table',
      status: 'pending',
    });
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'orders' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(artifactRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          id: 'tjdb-uuid',
          table_name: 'orders',
          columns: [
            {
              column_name: 'id',
              data_type: 'serial',
              constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
            },
          ],
        },
      })
    );
  });

  it('creates a Button component on a page created earlier in the plan (pageId validation applies to every widget type, not just Table)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateComponent', description: 'Create the Orders page' },
        { type: 'CreateComponent', description: 'Add a Save button' },
      ])
    )
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Orders' }))
      // Attempt 1: hallucinated pageId — rejected and retried.
      .mockResolvedValueOnce(componentToolCall({ type: 'Button', pageId: 'made-up', text: 'Save' }))
      .mockResolvedValueOnce(componentToolCall({ type: 'Button', pageId: 'page-1', text: 'Save' }));

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateComponent',
        description: 'Create the Orders page',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateComponent',
        description: 'Add a Save button',
        status: 'pending',
      });

    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Orders' }).mockResolvedValueOnce({
      id: 'button-1',
      pageId: 'page-1',
      type: 'Button',
    });

    artifactRepository.createOne
      .mockResolvedValueOnce({ id: 'artifact-1', content: { id: 'page-1', name: 'Orders' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-2',
        content: { id: 'button-1', pageId: 'page-1', type: 'Button' },
        identifier: 'button-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(2);
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(2, 'version-1', 'org-1', 'Button', {
      pageId: 'page-1',
      text: 'Save',
    });
  });

  it.each([
    ['Text', { pageId: 'page-1', text: 'Welcome' }],
    ['TextInput', { pageId: 'page-1', label: 'Email' }],
    ['Container', { pageId: 'page-1', title: 'Sidebar' }],
  ])(
    'dispatches a %s CreateComponent step to AgentsService.CreateComponent with the model-supplied props',
    async (type, props) => {
      const {
        service,
        aiUtilService,
        conversationRepo,
        messageRepo,
        agentsService,
        artifactRepository,
        stepRepository,
      } = buildService();

      conversationRepo.findById.mockResolvedValue({
        id: 'conv-1',
        userId: 'user-1',
        appId: 'app-1',
        conversationType: 'generate',
      });
      messageRepo.findLatestByConversationId.mockResolvedValue([
        { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
      ]);
      aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
        planToolCall([
          { type: 'CreateComponent', description: 'Create the page' },
          { type: 'CreateComponent', description: `Add a ${type}` },
        ])
      )
        .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Page' }))
        .mockResolvedValueOnce(componentToolCall({ type, ...(props as object) }));

      stepRepository.createOne
        .mockResolvedValueOnce({
          id: 'step-1',
          conversationId: 'conv-1',
          messageId: 'ai-msg-1',
          order: 0,
          type: 'CreateComponent',
          description: 'Create the page',
          status: 'pending',
        })
        .mockResolvedValueOnce({
          id: 'step-2',
          conversationId: 'conv-1',
          messageId: 'ai-msg-1',
          order: 1,
          type: 'CreateComponent',
          description: `Add a ${type}`,
          status: 'pending',
        });

      agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Page' }).mockResolvedValueOnce({
        id: 'widget-1',
        pageId: 'page-1',
        type,
      });

      artifactRepository.createOne
        .mockResolvedValueOnce({ id: 'artifact-1', content: { id: 'page-1', name: 'Page' }, identifier: 'page-1' })
        .mockResolvedValueOnce({
          id: 'artifact-2',
          content: { id: 'widget-1', pageId: 'page-1', type },
          identifier: 'widget-1',
        });

      await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

      expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(2, 'version-1', 'org-1', type, props);
    }
  );

  it('creates a Form bound to a table created earlier in the plan, passing the real columns through', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    const tableColumns = [
      {
        column_name: 'id',
        data_type: 'serial',
        constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
      },
      {
        column_name: 'name',
        data_type: 'character varying',
        constraints_type: { is_primary_key: false, is_not_null: true, is_unique: false },
      },
    ];

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateComponent', description: 'Create the Customers page' },
        { type: 'CreateComponent', description: 'Add a form to create customers' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Customers' }))
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Form', pageId: 'page-1', tableId: 'tjdb-uuid', title: 'New customer' })
      );

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateComponent',
        description: 'Create the Customers page',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-3',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 2,
        type: 'CreateComponent',
        description: 'Add a form to create customers',
        status: 'pending',
      });

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Customers' }).mockResolvedValueOnce({
      id: 'form-1',
      pageId: 'page-1',
      type: 'Form',
      tableId: 'tjdb-uuid',
    });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-uuid', table_name: 'customers', columns: tableColumns },
        identifier: 'customers',
      })
      .mockResolvedValueOnce({ id: 'artifact-2', content: { id: 'page-1', name: 'Customers' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'form-1', pageId: 'page-1', type: 'Form' },
        identifier: 'form-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // The Form step's execution passes the real prior CreateTable artifact's columns
    // through — that's what lets AgentsService build correct JSONSchema fields.
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(2, 'version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      tableId: 'tjdb-uuid',
      title: 'New customer',
      columns: tableColumns,
    });
  });

  it('rejects a Form step whose tableId does not match any table created earlier in this plan, then succeeds once the retry references the real one', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateComponent', description: 'Create the Customers page' },
        { type: 'CreateComponent', description: 'Add a form to create customers' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Customers' }))
      // Attempt 1: hallucinated tableId.
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Form', pageId: 'page-1', tableId: 'made-up-table-id', title: 'New customer' })
      )
      // Attempt 2 (retry): the real tableId.
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Form', pageId: 'page-1', tableId: 'tjdb-uuid', title: 'New customer' })
      );

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateComponent',
        description: 'Create the Customers page',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-3',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 2,
        type: 'CreateComponent',
        description: 'Add a form to create customers',
        status: 'pending',
      });

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Customers' }).mockResolvedValueOnce({
      id: 'form-1',
      pageId: 'page-1',
      type: 'Form',
    });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-uuid', table_name: 'customers', columns: [] },
        identifier: 'customers',
      })
      .mockResolvedValueOnce({ id: 'artifact-2', content: { id: 'page-1', name: 'Customers' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'form-1', pageId: 'page-1', type: 'Form' },
        identifier: 'form-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // Only two CreateComponent calls total: the Page, and the Form's successful (second)
    // attempt — the hallucinated-tableId attempt never reached AgentsService.
    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(2);
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(
      2,
      'version-1',
      'org-1',
      'Form',
      expect.objectContaining({ tableId: 'tjdb-uuid' })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-3',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });

  // Table's and Button's specs above already cover a pageId matching nothing at all; this one
  // covers the harder case #6's check exists for — a pageId that does match a prior component,
  // just not a Page.
  it('rejects a Form step whose pageId names another widget rather than the Page it sits on, then succeeds once the retry references the real Page', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateComponent', description: 'Create the Customers page' },
        { type: 'CreateComponent', description: 'Add a Save button' },
        { type: 'CreateComponent', description: 'Add a form to create customers' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Customers' }))
      .mockResolvedValueOnce(componentToolCall({ type: 'Button', pageId: 'page-1', text: 'Save' }))
      // Attempt 1: pageId names the Button — a real id, from a real CreateComponent step, that
      // simply isn't a Page. This is the case the id-matching alone can't catch: only the
      // "a Page artifact has no pageId of its own" discriminator rejects it.
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Form', pageId: 'button-1', tableId: 'tjdb-uuid', title: 'New customer' })
      )
      // Attempt 2 (retry): the real Page.
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Form', pageId: 'page-1', tableId: 'tjdb-uuid', title: 'New customer' })
      );

    stepRepository.createOne
      .mockResolvedValueOnce(pendingStep('step-1', 0, 'CreateTable', 'Create a customers table'))
      .mockResolvedValueOnce(pendingStep('step-2', 1, 'CreateComponent', 'Create the Customers page'))
      .mockResolvedValueOnce(pendingStep('step-3', 2, 'CreateComponent', 'Add a Save button'))
      .mockResolvedValueOnce(pendingStep('step-4', 3, 'CreateComponent', 'Add a form to create customers'));

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Customers' })
      .mockResolvedValueOnce({ id: 'button-1', pageId: 'page-1', type: 'Button' })
      // createFormComponent's real return shape: the widget plus its table/query wiring.
      .mockResolvedValueOnce({
        id: 'form-1',
        pageId: 'page-1',
        type: 'Form',
        tableId: 'tjdb-uuid',
        queryId: 'query-1',
        queryName: 'create_customers',
      });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-uuid', table_name: 'customers', columns: [] },
        identifier: 'customers',
      })
      // The Page's content carries no pageId of its own; the Button's does — that difference
      // is the whole basis of the check under test.
      .mockResolvedValueOnce({ id: 'artifact-2', content: { id: 'page-1', name: 'Customers' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'button-1', pageId: 'page-1', type: 'Button' },
        identifier: 'button-1',
      })
      .mockResolvedValueOnce({
        id: 'artifact-4',
        content: { id: 'form-1', pageId: 'page-1', type: 'Form' },
        identifier: 'form-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // Three calls: the Page, the Button, and the Form's successful (second) attempt — the
    // Form-nested-inside-a-Button attempt never reached AgentsService.
    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(3);
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(
      3,
      'version-1',
      'org-1',
      'Form',
      expect.objectContaining({ pageId: 'page-1' })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-4',
      expect.objectContaining({
        attempts: 1,
        errorMessage: expect.stringContaining('pageId "button-1" does not match any Page'),
      })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-4',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });

  it('builds an edit-mode Form bound to a Table widget created earlier in the plan on the same underlying table', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    const customersColumns = [
      {
        column_name: 'id',
        data_type: 'serial',
        constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
      },
      {
        column_name: 'name',
        data_type: 'character varying',
        constraints_type: { is_primary_key: false, is_not_null: true, is_unique: false },
      },
    ];

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateComponent', description: 'Create the Customers page' },
        { type: 'CreateQuery', description: 'List customers' },
        { type: 'CreateComponent', description: 'Add a customers table' },
        { type: 'CreateComponent', description: 'Add a form to edit customers' },
      ])
    )
      .mockResolvedValueOnce(
        createTableToolCall({
          table_name: 'customers',
          columns: [
            { column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true },
            {
              column_name: 'name',
              data_type: 'character varying',
              is_primary_key: false,
              is_not_null: true,
              is_unique: false,
            },
          ],
        })
      )
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Customers' }))
      .mockResolvedValueOnce(queryToolCall({ name: 'list_customers', table_id: 'tjdb-uuid' }))
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Table', pageId: 'page-1', title: 'customers_table', queryName: 'list_customers' })
      )
      .mockResolvedValueOnce(
        componentToolCall({
          type: 'Form',
          pageId: 'page-1',
          tableId: 'tjdb-uuid',
          title: 'Edit customer',
          mode: 'edit',
          tableName: 'customers_table',
        })
      );

    stepRepository.createOne
      .mockResolvedValueOnce(pendingStep('step-1', 0, 'CreateTable', 'Create a customers table'))
      .mockResolvedValueOnce(pendingStep('step-2', 1, 'CreateComponent', 'Create the Customers page'))
      .mockResolvedValueOnce(pendingStep('step-3', 2, 'CreateQuery', 'List customers'))
      .mockResolvedValueOnce(pendingStep('step-4', 3, 'CreateComponent', 'Add a customers table'))
      .mockResolvedValueOnce(pendingStep('step-5', 4, 'CreateComponent', 'Add a form to edit customers'));

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    agentsService.CreateQuery.mockResolvedValue({
      id: 'query-1',
      name: 'list_customers',
      options: { operation: 'list_rows', table_id: 'tjdb-uuid' },
    });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Customers' })
      .mockResolvedValueOnce({
        id: 'table-widget-1',
        pageId: 'page-1',
        type: 'Table',
        name: 'customers_table',
        queryName: 'list_customers',
      })
      .mockResolvedValueOnce({
        id: 'form-1',
        pageId: 'page-1',
        type: 'Form',
        tableId: 'tjdb-uuid',
        queryId: 'query-2',
        queryName: 'update_edit_customer',
        mode: 'edit',
        tableName: 'customers_table',
      });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-uuid', table_name: 'customers', columns: customersColumns },
        identifier: 'customers',
      })
      .mockResolvedValueOnce({ id: 'artifact-2', content: { id: 'page-1', name: 'Customers' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'query-1', name: 'list_customers', options: { operation: 'list_rows', table_id: 'tjdb-uuid' } },
        identifier: 'list_customers',
      })
      .mockResolvedValueOnce({
        id: 'artifact-4',
        content: {
          id: 'table-widget-1',
          pageId: 'page-1',
          type: 'Table',
          name: 'customers_table',
          queryName: 'list_customers',
        },
        identifier: 'table-widget-1',
      })
      .mockResolvedValueOnce({
        id: 'artifact-5',
        content: { id: 'form-1', pageId: 'page-1', type: 'Form' },
        identifier: 'form-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // The edit-mode Form reaches AgentsService with its mode, the referenced Table's component
    // name, and the real table columns (for field generation) — exactly what lets
    // AgentsService pre-fill fields from that Table's selectedRow and wire an update_rows query.
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(3, 'version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      tableId: 'tjdb-uuid',
      title: 'Edit customer',
      mode: 'edit',
      tableName: 'customers_table',
      columns: customersColumns,
    });
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-5',
      expect.objectContaining({ status: 'succeeded', attempts: 1 })
    );
  });

  it('rejects an edit-mode Form whose tableName does not match any Table widget in the plan, then succeeds once the retry references the real one', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    const customersColumns = [
      {
        column_name: 'id',
        data_type: 'serial',
        constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
      },
      {
        column_name: 'name',
        data_type: 'character varying',
        constraints_type: { is_primary_key: false, is_not_null: true, is_unique: false },
      },
    ];

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateComponent', description: 'Create the Customers page' },
        { type: 'CreateQuery', description: 'List customers' },
        { type: 'CreateComponent', description: 'Add a customers table' },
        { type: 'CreateComponent', description: 'Add a form to edit customers' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Customers' }))
      .mockResolvedValueOnce(queryToolCall({ name: 'list_customers', table_id: 'tjdb-uuid' }))
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Table', pageId: 'page-1', title: 'customers_table', queryName: 'list_customers' })
      )
      // Attempt 1: hallucinated tableName — no such Table widget was created.
      .mockResolvedValueOnce(
        componentToolCall({
          type: 'Form',
          pageId: 'page-1',
          tableId: 'tjdb-uuid',
          title: 'Edit customer',
          mode: 'edit',
          tableName: 'made-up-table',
        })
      )
      // Attempt 2 (retry): the real Table widget.
      .mockResolvedValueOnce(
        componentToolCall({
          type: 'Form',
          pageId: 'page-1',
          tableId: 'tjdb-uuid',
          title: 'Edit customer',
          mode: 'edit',
          tableName: 'customers_table',
        })
      );

    stepRepository.createOne
      .mockResolvedValueOnce(pendingStep('step-1', 0, 'CreateTable', 'Create a customers table'))
      .mockResolvedValueOnce(pendingStep('step-2', 1, 'CreateComponent', 'Create the Customers page'))
      .mockResolvedValueOnce(pendingStep('step-3', 2, 'CreateQuery', 'List customers'))
      .mockResolvedValueOnce(pendingStep('step-4', 3, 'CreateComponent', 'Add a customers table'))
      .mockResolvedValueOnce(pendingStep('step-5', 4, 'CreateComponent', 'Add a form to edit customers'));

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    agentsService.CreateQuery.mockResolvedValue({
      id: 'query-1',
      name: 'list_customers',
      options: { operation: 'list_rows', table_id: 'tjdb-uuid' },
    });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Customers' })
      .mockResolvedValueOnce({
        id: 'table-widget-1',
        pageId: 'page-1',
        type: 'Table',
        name: 'customers_table',
        queryName: 'list_customers',
      })
      .mockResolvedValueOnce({
        id: 'form-1',
        pageId: 'page-1',
        type: 'Form',
        tableId: 'tjdb-uuid',
        queryId: 'query-2',
        queryName: 'update_edit_customer',
        mode: 'edit',
        tableName: 'customers_table',
      });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-uuid', table_name: 'customers', columns: customersColumns },
        identifier: 'customers',
      })
      .mockResolvedValueOnce({ id: 'artifact-2', content: { id: 'page-1', name: 'Customers' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-3',
        content: { id: 'query-1', name: 'list_customers', options: { operation: 'list_rows', table_id: 'tjdb-uuid' } },
        identifier: 'list_customers',
      })
      .mockResolvedValueOnce({
        id: 'artifact-4',
        content: {
          id: 'table-widget-1',
          pageId: 'page-1',
          type: 'Table',
          name: 'customers_table',
          queryName: 'list_customers',
        },
        identifier: 'table-widget-1',
      })
      .mockResolvedValueOnce({
        id: 'artifact-5',
        content: { id: 'form-1', pageId: 'page-1', type: 'Form' },
        identifier: 'form-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    // Only three CreateComponent calls total: Page, Table, and the Form's successful (second)
    // attempt — the hallucinated-tableName attempt never reached AgentsService.
    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(3);
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(
      3,
      'version-1',
      'org-1',
      'Form',
      expect.objectContaining({ tableName: 'customers_table', mode: 'edit' })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-5',
      expect.objectContaining({
        errorMessage: expect.stringContaining('tableName "made-up-table" does not match any Table widget'),
      })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-5',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });

  it('rejects an edit-mode Form whose referenced Table widget is bound to a different table, then succeeds once the retry matches them', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create a customers table' },
        { type: 'CreateTable', description: 'Create a products table' },
        { type: 'CreateComponent', description: 'Create the Catalog page' },
        { type: 'CreateQuery', description: 'List products' },
        { type: 'CreateComponent', description: 'Add a products table' },
        { type: 'CreateComponent', description: 'Add a form to edit products' },
      ])
    )
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')))
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('products')))
      .mockResolvedValueOnce(componentToolCall({ type: 'Page', name: 'Catalog' }))
      .mockResolvedValueOnce(queryToolCall({ name: 'list_products', table_id: 'tjdb-products-uuid' }))
      .mockResolvedValueOnce(
        componentToolCall({ type: 'Table', pageId: 'page-1', title: 'products_table', queryName: 'list_products' })
      )
      // Attempt 1: the Form targets customers, but the referenced Table widget is bound (via its
      // query) to products — the two must agree.
      .mockResolvedValueOnce(
        componentToolCall({
          type: 'Form',
          pageId: 'page-1',
          tableId: 'tjdb-customers-uuid',
          title: 'Edit product',
          mode: 'edit',
          tableName: 'products_table',
        })
      )
      // Attempt 2 (retry): the Form now targets the same table the Table widget actually shows.
      .mockResolvedValueOnce(
        componentToolCall({
          type: 'Form',
          pageId: 'page-1',
          tableId: 'tjdb-products-uuid',
          title: 'Edit product',
          mode: 'edit',
          tableName: 'products_table',
        })
      );

    stepRepository.createOne
      .mockResolvedValueOnce(pendingStep('step-1', 0, 'CreateTable', 'Create a customers table'))
      .mockResolvedValueOnce(pendingStep('step-2', 1, 'CreateTable', 'Create a products table'))
      .mockResolvedValueOnce(pendingStep('step-3', 2, 'CreateComponent', 'Create the Catalog page'))
      .mockResolvedValueOnce(pendingStep('step-4', 3, 'CreateQuery', 'List products'))
      .mockResolvedValueOnce(pendingStep('step-5', 4, 'CreateComponent', 'Add a products table'))
      .mockResolvedValueOnce(pendingStep('step-6', 5, 'CreateComponent', 'Add a form to edit products'));

    agentsService.CreateTable.mockResolvedValueOnce({
      id: 'tjdb-customers-uuid',
      table_name: 'customers',
    }).mockResolvedValueOnce({ id: 'tjdb-products-uuid', table_name: 'products' });
    agentsService.CreateQuery.mockResolvedValue({
      id: 'query-1',
      name: 'list_products',
      options: { operation: 'list_rows', table_id: 'tjdb-products-uuid' },
    });
    agentsService.CreateComponent.mockResolvedValueOnce({ id: 'page-1', name: 'Catalog' })
      .mockResolvedValueOnce({
        id: 'table-widget-1',
        pageId: 'page-1',
        type: 'Table',
        name: 'products_table',
        queryName: 'list_products',
      })
      .mockResolvedValueOnce({
        id: 'form-1',
        pageId: 'page-1',
        type: 'Form',
        tableId: 'tjdb-products-uuid',
        queryId: 'query-2',
        queryName: 'update_edit_product',
        mode: 'edit',
        tableName: 'products_table',
      });

    artifactRepository.createOne
      .mockResolvedValueOnce({
        id: 'artifact-1',
        content: { id: 'tjdb-customers-uuid', table_name: 'customers', columns: [] },
        identifier: 'customers',
      })
      .mockResolvedValueOnce({
        id: 'artifact-2',
        content: { id: 'tjdb-products-uuid', table_name: 'products', columns: [] },
        identifier: 'products',
      })
      .mockResolvedValueOnce({ id: 'artifact-3', content: { id: 'page-1', name: 'Catalog' }, identifier: 'page-1' })
      .mockResolvedValueOnce({
        id: 'artifact-4',
        content: {
          id: 'query-1',
          name: 'list_products',
          options: { operation: 'list_rows', table_id: 'tjdb-products-uuid' },
        },
        identifier: 'list_products',
      })
      .mockResolvedValueOnce({
        id: 'artifact-5',
        content: {
          id: 'table-widget-1',
          pageId: 'page-1',
          type: 'Table',
          name: 'products_table',
          queryName: 'list_products',
        },
        identifier: 'table-widget-1',
      })
      .mockResolvedValueOnce({
        id: 'artifact-6',
        content: { id: 'form-1', pageId: 'page-1', type: 'Form' },
        identifier: 'form-1',
      });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(3);
    expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(
      3,
      'version-1',
      'org-1',
      'Form',
      expect.objectContaining({ tableId: 'tjdb-products-uuid' })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-6',
      expect.objectContaining({
        errorMessage: expect.stringContaining('is not bound to the same ToolJet DB table'),
      })
    );
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-6',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });
});

/** @group platform */
describe('AiService.approvePrd - queries against connected external data sources', () => {
  const planToolCall = (steps: any[]) => ({ toolCalls: [{ toolName: 'proposeStepPlan', args: { steps } }] });
  const queryToolCall = (args: any) => ({ toolCalls: [{ toolName: 'createQuery', args }] });

  const WAREHOUSE = { id: 'ds-warehouse', name: 'Warehouse', kind: 'postgresql', tables: ['orders', 'customers'] };

  // One CreateQuery step, with the conversation/message/step plumbing every test here needs.
  const buildQueryStepService = (overrides: Partial<Record<string, any>> = {}) => {
    const harness = buildService(overrides);
    const { conversationRepo, messageRepo, stepRepository } = harness;

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateQuery',
      description: 'List customers',
      status: 'pending',
    });

    return harness;
  };

  it("creates the query against the source the model picked, in that source's own query shape", async () => {
    const { service, aiUtilService, agentsService, dataSourceInventoryService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValueOnce(
      queryToolCall({
        source: 'sql',
        name: 'list_customers',
        data_source_id: 'ds-warehouse',
        sql: 'SELECT * FROM customers LIMIT 100',
      })
    );
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_customers' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).toHaveBeenCalledWith('version-1', 'org-1', {
      name: 'list_customers',
      dataSourceId: 'ds-warehouse',
      options: { mode: 'sql', query: 'SELECT * FROM customers LIMIT 100' },
    });
  });

  it('assembles the connected sources once per approval, not once per query step', async () => {
    const { service, aiUtilService, agentsService, dataSourceInventoryService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateQuery', description: 'List customers' },
        { type: 'CreateQuery', description: 'List orders' },
      ])
    ).mockResolvedValue(queryToolCall({ source: 'sql', name: 'q', data_source_id: 'ds-warehouse', sql: 'SELECT 1' }));
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'q' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(dataSourceInventoryService.listQueryableSources).toHaveBeenCalledTimes(1);
    expect(dataSourceInventoryService.listQueryableSources).toHaveBeenCalledWith(USER, PERMISSIONS);
  });

  // Same reasoning as the pageId/queryName guards: the tool schema can only ask for a string,
  // so an id the model invented is caught here. Retryable - the model picks it per attempt.
  it('rejects a data source id that is not one of the connected sources, and retries', async () => {
    const { service, aiUtilService, agentsService, stepRepository, dataSourceInventoryService } =
      buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValue(queryToolCall({ source: 'sql', name: 'q', data_source_id: 'ds-invented', sql: 'SELECT 1' }));

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('ds-invented') })
    );
    // 1 planner call + 1 initial attempt + 2 retries, each asking the model again.
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(4);
  });

  // The tool schema and the prompt both ask for one SELECT, and nothing here runs the
  // statement to find out what it really is: a stored DELETE would sit in the app until a
  // user pressed Run, and then it would be their data.
  it.each([
    ['a write', 'DELETE FROM customers'],
    ['a schema change', 'DROP TABLE customers'],
    ['a second statement smuggled in after the SELECT', 'SELECT * FROM customers; DROP TABLE customers'],
    ['a write hidden behind a comment', 'SELECT 1 -- ok\nUPDATE customers SET name = 1'],
    ['a row lock', 'SELECT * FROM customers FOR UPDATE'],
  ])('refuses to store %s as a query', async (_name, sql) => {
    const { service, aiUtilService, agentsService, stepRepository, dataSourceInventoryService } =
      buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValue(queryToolCall({ source: 'sql', name: 'q', data_source_id: 'ds-warehouse', sql }));

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', expect.objectContaining({ status: 'failed' }));
  });

  it('accepts a read that leads with a CTE', async () => {
    const { service, aiUtilService, agentsService, dataSourceInventoryService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    const sql = 'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent';
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List recent orders' }])
    ).mockResolvedValueOnce(
      queryToolCall({ source: 'sql', name: 'recent_orders', data_source_id: 'ds-warehouse', sql })
    );
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'recent_orders' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).toHaveBeenCalledWith(
      'version-1',
      'org-1',
      expect.objectContaining({ options: { mode: 'sql', query: sql } })
    );
  });

  it('refuses to store a query with no SQL at all rather than persisting an undefined body', async () => {
    const { service, aiUtilService, agentsService, stepRepository, dataSourceInventoryService } =
      buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValue(queryToolCall({ source: 'sql', name: 'q', data_source_id: 'ds-warehouse' }));

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', expect.objectContaining({ status: 'failed' }));
  });

  it('rejects an external query when nothing external is connected at all', async () => {
    const { service, aiUtilService, agentsService, stepRepository } = buildQueryStepService();

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValue(queryToolCall({ source: 'sql', name: 'q', data_source_id: 'ds-warehouse', sql: 'SELECT 1' }));

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', expect.objectContaining({ status: 'failed' }));
  });

  it('still targets ToolJet DB when the model names no source, which is what every existing plan does', async () => {
    const { service, aiUtilService, agentsService, dataSourceInventoryService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List orders' }])
    ).mockResolvedValueOnce(queryToolCall({ name: 'list_orders', table_id: 'table-uuid' }));
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_orders' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    expect(agentsService.CreateQuery).toHaveBeenCalledWith('version-1', 'org-1', {
      name: 'list_orders',
      options: { operation: 'list_rows', table_id: 'table-uuid', list_rows: { limit: 100 } },
    });
  });

  it("shows the planner and the query step the connected sources and each source's real tables", async () => {
    const { service, aiUtilService, agentsService, dataSourceInventoryService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValueOnce(
      queryToolCall({ source: 'sql', name: 'list_customers', data_source_id: 'ds-warehouse', sql: 'SELECT 1' })
    );
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_customers' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    const plannerPrompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    expect(plannerPrompt).toContain('Warehouse');
    expect(plannerPrompt).toContain('ds-warehouse');

    const queryStepPrompt = aiUtilService.AIGatewayGenerate.mock.calls[1][2].messages[0].content;
    expect(queryStepPrompt).toContain('ds-warehouse');
    expect(queryStepPrompt).toContain('customers');
  });

  // ADR-0018: an external source can never receive a CreateTable, so the planner has to be
  // told that before it proposes one it cannot build.
  it('tells the planner that tables cannot be created in a connected external source', async () => {
    const { service, aiUtilService, agentsService, dataSourceInventoryService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List customers' }])
    ).mockResolvedValueOnce(
      queryToolCall({ source: 'sql', name: 'list_customers', data_source_id: 'ds-warehouse', sql: 'SELECT 1' })
    );
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_customers' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    const plannerPrompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    expect(plannerPrompt).toMatch(/CreateTable/);
    expect(plannerPrompt).toMatch(/ToolJet DB/);
  });

  it('says nothing about external data sources in any prompt when none are connected', async () => {
    const { service, aiUtilService, agentsService } = buildQueryStepService();

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'List orders' }])
    ).mockResolvedValueOnce(queryToolCall({ name: 'list_orders', table_id: 'table-uuid' }));
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_orders' });

    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);

    const plannerPrompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    const queryStepPrompt = aiUtilService.AIGatewayGenerate.mock.calls[1][2].messages[0].content;
    expect(plannerPrompt).not.toContain('Connected data sources');
    expect(queryStepPrompt).not.toContain('Connected data sources');
  });
  it('strips CreateTable steps from the plan when an external dataSourceId is provided', async () => {
    const { service, agentsService, dataSourceInventoryService, aiUtilService } = buildQueryStepService();
    dataSourceInventoryService.listQueryableSources.mockResolvedValue([WAREHOUSE]);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        { type: 'CreateTable', description: 'Create orders table' },
        { type: 'CreateQuery', description: 'List orders' },
      ])
    ).mockResolvedValueOnce(
      queryToolCall({ source: 'sql', name: 'list_orders', data_source_id: 'ds-warehouse', sql: 'SELECT 1' })
    );
    agentsService.CreateQuery.mockResolvedValue({ id: 'query-1', name: 'list_orders' });
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any, 'ds-warehouse');
    // The planner may still propose CreateTable, but agentsService.CreateTable must never
    // be called when the user selected an external data source.
    expect(agentsService.CreateTable).not.toHaveBeenCalled();
    expect(agentsService.CreateQuery).toHaveBeenCalled();
  });
  it('keeps CreateTable steps when no dataSourceId is provided (default ToolJet DB path)', async () => {
    const { service, stepRepository, agentsService, aiUtilService } = buildQueryStepService();
    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'orders' });
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateTable', description: 'Create orders table' }])
    ).mockResolvedValueOnce({ toolCalls: [] });
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, buildMockResponse() as any);
    const callTypes = stepRepository.createOne.mock.calls.map((c) => c[0].type);
    expect(callTypes).toContain('CreateTable');
  });
});

/** @group platform */
describe('AiService.previewPlan', () => {
  const planToolCall = (steps: any[]) => ({
    toolCalls: [{ toolName: 'proposeStepPlan', args: { steps } }],
  });

  const customersTable = {
    table_name: 'customers',
    columns: [
      {
        column_name: 'id',
        data_type: 'serial',
        is_primary_key: true,
        is_not_null: true,
        is_unique: true,
      },
      {
        column_name: 'name',
        data_type: 'character varying',
        is_primary_key: false,
        is_not_null: true,
        is_unique: false,
      },
    ],
  };

  const mockGenerateConversation = (conversationRepo, messageRepo) => {
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'ai-msg-1', messageType: 'ai', content: 'PRD' }]);
  };

  it('generates and persists a plan and returns CreateTable steps with their proposed table definitions', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();

    mockGenerateConversation(conversationRepo, messageRepo);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        {
          type: 'CreateTable',
          description: 'Create a customers table',
          table: customersTable,
        },
        { type: 'CreateComponent', description: 'Create a page' },
      ])
    );
    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        plannedTable: customersTable,
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateComponent',
        description: 'Create a page',
        status: 'pending',
      });

    const result = await service.previewPlan('conv-1', USER, PERMISSIONS);

    expect(stepRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'CreateTable',
        plannedTable: customersTable,
      })
    );
    expect(stepRepository.createOne).toHaveBeenCalledWith(expect.objectContaining({ type: 'CreateComponent' }));
    expect(result).toEqual({
      steps: [
        {
          id: 'step-1',
          type: 'CreateTable',
          description: 'Create a customers table',
          table: customersTable,
        },
        { id: 'step-2', type: 'CreateComponent', description: 'Create a page' },
      ],
    });
  });

  it('reuses pending Steps already persisted for this PRD message instead of calling the planner again', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();

    mockGenerateConversation(conversationRepo, messageRepo);
    stepRepository.findPendingForMessage.mockResolvedValue([
      {
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        plannedTable: customersTable,
        status: 'pending',
      },
    ]);

    const result = await service.previewPlan('conv-1', USER, PERMISSIONS);

    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
    expect(stepRepository.createOne).not.toHaveBeenCalled();
    expect(result).toEqual({
      steps: [
        {
          id: 'step-1',
          type: 'CreateTable',
          description: 'Create a customers table',
          table: customersTable,
        },
      ],
    });
  });

  it('strips CreateTable steps (with their table definitions) when an external dataSourceId is provided', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();

    mockGenerateConversation(conversationRepo, messageRepo);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        {
          type: 'CreateTable',
          description: 'Create a customers table',
          table: customersTable,
        },
      ])
    );
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateTable',
      description: 'Create a customers table',
      plannedTable: customersTable,
      status: 'pending',
    });

    const result = await service.previewPlan('conv-1', USER, PERMISSIONS, 'ds-1');

    expect(result).toEqual({ steps: [] });
  });

  it('rejects a Learn conversation — it has no PRD to preview a plan for', async () => {
    const { service, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'learn',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'answer' },
    ]);

    await expect(service.previewPlan('conv-1', USER, PERMISSIONS)).rejects.toThrow(BadRequestException);
  });

  it('rejects when there is no AI message (PRD) to plan from', async () => {
    const { service, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'user-msg-1', messageType: 'user', content: 'hi' },
    ]);

    await expect(service.previewPlan('conv-1', USER, PERMISSIONS)).rejects.toThrow(BadRequestException);
  });
});

describe('AiService.approvePrd - previewed plans (ticket #20)', () => {
  const planToolCall = (steps: any[]) => ({
    toolCalls: [{ toolName: 'proposeStepPlan', args: { steps } }],
  });

  const customersTable = {
    table_name: 'customers',
    columns: [
      {
        column_name: 'id',
        data_type: 'serial',
        is_primary_key: true,
        is_not_null: true,
        is_unique: true,
      },
      {
        column_name: 'name',
        data_type: 'character varying',
        is_primary_key: false,
        is_not_null: true,
        is_unique: false,
      },
    ],
  };

  it('executes a previewed CreateTable step deterministically from its planned table — no per-step LLM call, so what was previewed is what gets created', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'ai-msg-1', messageType: 'ai', content: 'PRD' }]);
    stepRepository.findPendingForMessage.mockResolvedValue([
      {
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        plannedTable: customersTable,
        status: 'pending',
      },
    ]);
    agentsService.CreateTable.mockResolvedValue({
      id: 'tjdb-uuid',
      table_name: 'customers',
    });
    artifactRepository.createOne.mockResolvedValue({ id: 'artifact-1' });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response as any);

    // The planner is not re-run (the previewed plan is reused) and the create-table step
    // makes no LLM call at all — the planned table is the contract.
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
    expect(agentsService.CreateTable).toHaveBeenCalledWith('org-1', {
      table_name: 'customers',
      columns: [
        {
          column_name: 'id',
          data_type: 'serial',
          constraints_type: {
            is_primary_key: true,
            is_not_null: true,
            is_unique: true,
          },
        },
        {
          column_name: 'name',
          data_type: 'character varying',
          constraints_type: {
            is_primary_key: false,
            is_not_null: true,
            is_unique: false,
          },
        },
      ],
    });
    // The plan event still carries the table definition so late joiners of the stream can render it.
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'plan',
      expect.objectContaining({
        steps: [
          expect.objectContaining({
            id: 'step-1',
            type: 'CreateTable',
            table: customersTable,
          }),
        ],
      })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
      succeeded: 1,
      total: 1,
    });
  });

  it('falls back to the LLM path when a pending CreateTable step has no well-formed planned table (e.g. plans persisted before #20)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'ai-msg-1', messageType: 'ai', content: 'PRD' }]);
    stepRepository.findPendingForMessage.mockResolvedValue([
      {
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        plannedTable: { table_name: 'customers' },
        status: 'pending',
      },
    ]);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce({
      toolCalls: [{ toolName: 'createTable', args: customersTable }],
    });
    agentsService.CreateTable.mockResolvedValue({
      id: 'tjdb-uuid',
      table_name: 'customers',
    });
    artifactRepository.createOne.mockResolvedValue({ id: 'artifact-1' });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response as any);

    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(1);
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
      succeeded: 1,
      total: 1,
    });
  });

  it('ignores malformed planned tables (no columns) and falls back to the LLM path', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'ai-msg-1', messageType: 'ai', content: 'PRD' }]);
    stepRepository.findPendingForMessage.mockResolvedValue([
      {
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        plannedTable: { table_name: 'customers', columns: [] },
        status: 'pending',
      },
    ]);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce({
      toolCalls: [{ toolName: 'createTable', args: customersTable }],
    });
    agentsService.CreateTable.mockResolvedValue({
      id: 'tjdb-uuid',
      table_name: 'customers',
    });
    artifactRepository.createOne.mockResolvedValue({ id: 'artifact-1' });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD', USER, PERMISSIONS, response as any);

    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(1);
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
      succeeded: 1,
      total: 1,
    });
  });

  it('does not reuse pending Steps from a different (older) PRD message — a refined PRD gets a fresh plan', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();

    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'user-msg-0', messageType: 'user', content: 'earlier' },
      { id: 'ai-msg-2', messageType: 'ai', content: 'refined PRD' },
    ]);
    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([
        {
          type: 'CreateTable',
          description: 'Create a customers table',
          table: customersTable,
        },
      ])
    );
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-2',
      order: 0,
      type: 'CreateTable',
      description: 'Create a customers table',
      plannedTable: customersTable,
      status: 'pending',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'refined PRD', USER, PERMISSIONS, response as any);

    expect(stepRepository.findPendingForMessage).toHaveBeenCalledWith('conv-1', 'ai-msg-2');
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(1);
  });
});
describe('AiService.rewindStep', () => {
  it('rejects when conversationId or stepId is missing', async () => {
    const { service } = buildService();

    await expect(service.rewindStep(null, 'step-1', 'user-1', 'org-1')).rejects.toThrow(BadRequestException);
    await expect(service.rewindStep('conv-1', null, 'user-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('404s when the step does not exist, or belongs to a different conversation', async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    stepRepository.findById.mockResolvedValue(null);

    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toThrow(NotFoundException);

    stepRepository.findById.mockResolvedValue({ id: 'step-1', conversationId: 'conv-other', status: 'succeeded' });
    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects rewinding to a step that never completed', async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    stepRepository.findById.mockResolvedValue({ id: 'step-1', conversationId: 'conv-1', status: 'pending' });

    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('undoes every succeeded step after the target, back to front, then resets each to pending', async () => {
    const { service, conversationRepo, stepRepository, artifactRepository, agentsService, versionRepository } =
      buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    versionRepository.getAllVersions.mockResolvedValue([{ id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' }]);

    const targetStep = {
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      order: 0,
      status: 'succeeded',
    };
    stepRepository.findById.mockResolvedValue(targetStep);

    const stepsAfter = [
      {
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 1,
        type: 'CreateTable',
        status: 'succeeded',
        artifactId: 'artifact-2',
      },
      {
        id: 'step-3',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 2,
        type: 'CreateComponent',
        status: 'succeeded',
        artifactId: 'artifact-3',
      },
    ];
    stepRepository.findAfterOrder.mockResolvedValue(stepsAfter);

    const undoneOrder: string[] = [];
    artifactRepository.findById.mockImplementation(async (id) => {
      if (id === 'artifact-2') return { id: 'artifact-2', content: { id: 'tjdb-1', table_name: 'orders' } };
      if (id === 'artifact-3') return { id: 'artifact-3', content: { id: 'component-1', pageId: 'page-1' } };
      return null;
    });
    agentsService.undoArtifact.mockImplementation(async (type, appVersionId, organizationId, content) => {
      undoneOrder.push(content.id);
    });

    const result = await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1');

    // Reverse order: step-3's artifact (component-1) is undone before step-2's (tjdb-1) —
    // a later step can only reference an earlier one's output, never the reverse.
    expect(undoneOrder).toEqual(['component-1', 'tjdb-1']);
    expect(agentsService.undoArtifact).toHaveBeenCalledWith('CreateComponent', 'version-1', 'org-1', {
      id: 'component-1',
      pageId: 'page-1',
    });
    expect(agentsService.undoArtifact).toHaveBeenCalledWith('CreateTable', 'version-1', 'org-1', {
      id: 'tjdb-1',
      table_name: 'orders',
    });
    expect(artifactRepository.deleteOne).toHaveBeenCalledWith('artifact-2');
    expect(artifactRepository.deleteOne).toHaveBeenCalledWith('artifact-3');
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-2', {
      status: 'pending',
      artifactId: null,
      errorMessage: null,
      attempts: 0,
    });
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-3', {
      status: 'pending',
      artifactId: null,
      errorMessage: null,
      attempts: 0,
    });
    // The target step itself is untouched — rewind returns to the state right after it
    // finished, not before it.
    expect(stepRepository.updateOne).not.toHaveBeenCalledWith('step-1', expect.anything());
    expect(result).toEqual({ rewoundTo: 'step-1', undone: ['step-2', 'step-3'] });
  });

  it('a partial-plan rewind only touches steps after the target, leaving earlier ones alone', async () => {
    const { service, conversationRepo, stepRepository, artifactRepository, agentsService } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });

    // Rewinding to the middle step (order 1) of a 3-step plan.
    const targetStep = { id: 'step-2', conversationId: 'conv-1', messageId: 'msg-1', order: 1, status: 'succeeded' };
    stepRepository.findById.mockResolvedValue(targetStep);
    stepRepository.findAfterOrder.mockResolvedValue([
      {
        id: 'step-3',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 2,
        type: 'CreateComponent',
        status: 'succeeded',
        artifactId: 'artifact-3',
      },
    ]);
    artifactRepository.findById.mockResolvedValue({
      id: 'artifact-3',
      content: { id: 'component-1', pageId: 'page-1' },
    });

    const result = await service.rewindStep('conv-1', 'step-2', 'user-1', 'org-1');

    expect(stepRepository.findAfterOrder).toHaveBeenCalledWith('conv-1', 'msg-1', 1);
    // Only step-3 is undone/reset — step-1 (before the target) was never fetched at all.
    expect(stepRepository.updateOne).toHaveBeenCalledTimes(1);
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-3', expect.objectContaining({ status: 'pending' }));
    expect(agentsService.undoArtifact).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rewoundTo: 'step-2', undone: ['step-3'] });
  });

  it("scopes 'steps after the target' to the target's own plan (messageId) — a separately approved PRD's steps are never touched", async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'msg-plan-2',
      order: 0,
      status: 'succeeded',
    });
    stepRepository.findAfterOrder.mockResolvedValue([]);

    await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1');

    // Scoped by this plan's own messageId, not just conversationId — an earlier plan's
    // (msg-plan-1) steps are a disjoint set findAfterOrder never sees.
    expect(stepRepository.findAfterOrder).toHaveBeenCalledWith('conv-1', 'msg-plan-2', 0);
  });

  it('resets a failed step after the target back to pending too, even though it has no artifact to undo', async () => {
    const { service, conversationRepo, stepRepository, artifactRepository, agentsService } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      order: 0,
      status: 'succeeded',
    });
    stepRepository.findAfterOrder.mockResolvedValue([
      {
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 1,
        type: 'CreateTable',
        status: 'failed',
        artifactId: null,
      },
    ]);

    await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1');

    expect(artifactRepository.findById).not.toHaveBeenCalled();
    expect(agentsService.undoArtifact).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-2', {
      status: 'pending',
      artifactId: null,
      errorMessage: null,
      attempts: 0,
    });
  });

  it('propagates an undo failure and stops, leaving steps at/before the failure untouched by that step', async () => {
    const { service, conversationRepo, stepRepository, artifactRepository, agentsService } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      order: 0,
      status: 'succeeded',
    });
    stepRepository.findAfterOrder.mockResolvedValue([
      {
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 1,
        type: 'CreateTable',
        status: 'succeeded',
        artifactId: 'artifact-2',
      },
    ]);
    artifactRepository.findById.mockResolvedValue({
      id: 'artifact-2',
      content: { id: 'tjdb-1', table_name: 'orders' },
    });
    agentsService.undoArtifact.mockRejectedValue(new Error("Table can't be deleted, it is being used in app queries"));

    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toThrow(
      "Table can't be deleted, it is being used in app queries"
    );
    expect(artifactRepository.deleteOne).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).not.toHaveBeenCalled();
  });

  // IDOR regression (CRITICAL): rewind mutates the target app's state, so the conversation
  // must belong to the acting user even when its UUID and a step id are known.
  it('404s when the conversation belongs to another user (ownership enforced)', async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-2', conversationType: 'generate' });
    stepRepository.findById.mockResolvedValue({ id: 'step-1', conversationId: 'conv-1', status: 'succeeded' });

    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toThrow(NotFoundException);
    expect(stepRepository.updateOne).not.toHaveBeenCalled();
  });
});

// Ticket #15: the "undo this build" offer after a failed plan reuses rewind's discard by
// rewinding *inclusively* to the plan's first step — the target step's own Artifact is
// undone too, so nothing the plan built survives.
describe('AiService.rewindStep - inclusive (ticket #15)', () => {
  const arrangeFailedBuild = (buildService) => {
    const mocks = buildService();
    mocks.conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });
    mocks.versionRepository.getAllVersions.mockResolvedValue([
      { id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    // A build that failed at its second step: the first step succeeded and produced
    // an Artifact; the failed one produced nothing.
    mocks.stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      order: 0,
      type: 'CreateComponent',
      status: 'succeeded',
      artifactId: 'artifact-1',
    });
    mocks.stepRepository.findAfterOrder.mockResolvedValue([
      {
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 1,
        type: 'CreateQuery',
        status: 'failed',
        artifactId: null,
      },
    ]);
    mocks.artifactRepository.findById.mockResolvedValue({
      id: 'artifact-1',
      content: { id: 'component-1', pageId: 'page-1' },
    });
    return mocks;
  };

  it('undoes the target step itself, in the same back-to-front pass as the steps after it', async () => {
    const { service, stepRepository, artifactRepository, agentsService } = arrangeFailedBuild(buildService);
    stepRepository.findAfterOrder.mockResolvedValue([
      {
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        order: 1,
        type: 'CreateComponent',
        status: 'succeeded',
        artifactId: 'artifact-2',
      },
    ]);
    artifactRepository.findById.mockImplementation(async (id) =>
      id === 'artifact-1'
        ? { id: 'artifact-1', content: { id: 'tjdb-1', table_name: 'orders' } }
        : { id: 'artifact-2', content: { id: 'component-1', pageId: 'page-1' } }
    );

    const result = await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1', true);

    // The target's artifact is undone LAST (back-to-front holds with the target included).
    expect(agentsService.undoArtifact).toHaveBeenCalledTimes(2);
    expect(agentsService.undoArtifact).toHaveBeenLastCalledWith('CreateComponent', 'version-1', 'org-1', {
      id: 'tjdb-1',
      table_name: 'orders',
    });
    expect(artifactRepository.deleteOne).toHaveBeenCalledWith('artifact-1');
    // The target step is reset to pending like the rest — nothing of the plan survives.
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', {
      status: 'pending',
      artifactId: null,
      errorMessage: null,
      attempts: 0,
    });
    expect(result).toEqual({ rewoundTo: 'step-1', undone: ['step-1', 'step-2'] });
  });

  it('resets a whole failed plan: the first step and the failed step after it, undoing only the artifact', async () => {
    const { service, stepRepository, agentsService } = arrangeFailedBuild(buildService);

    const result = await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1', true);

    expect(agentsService.undoArtifact).toHaveBeenCalledTimes(1);
    expect(agentsService.undoArtifact).toHaveBeenCalledWith('CreateComponent', 'version-1', 'org-1', {
      id: 'component-1',
      pageId: 'page-1',
    });
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', expect.objectContaining({ status: 'pending' }));
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-2', expect.objectContaining({ status: 'pending' }));
    expect(result).toEqual({ rewoundTo: 'step-1', undone: ['step-1', 'step-2'] });
  });

  it('leaves the target step untouched without the flag — inclusive is opt-in per request', async () => {
    const { service, stepRepository, agentsService } = arrangeFailedBuild(buildService);

    await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1');

    expect(agentsService.undoArtifact).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).not.toHaveBeenCalledWith('step-1', expect.anything());
  });
});

/** @group platform */
describe('AiService.voteAiMessage', () => {
  it('rejects when messageId or voteType is missing', async () => {
    const { service } = buildService();

    await expect(service.voteAiMessage(null, 'up', 'user-1')).rejects.toThrow(BadRequestException);
    await expect(service.voteAiMessage('msg-1', null, 'user-1')).rejects.toThrow(BadRequestException);
  });

  it('rejects a voteType that is neither "up" nor "down"', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'msg-1' });

    await expect(service.voteAiMessage('msg-1', 'sideways', 'user-1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the message does not exist', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue(null);

    await expect(service.voteAiMessage('msg-1', 'up', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('creates a new vote when none exists yet for this message', async () => {
    const { service, messageRepo, aiResponseVoteRepository } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'msg-1' });
    aiResponseVoteRepository.findByMessageId.mockResolvedValue(null);
    aiResponseVoteRepository.createOne.mockResolvedValue({
      id: 'vote-1',
      aiConversationMessageId: 'msg-1',
      userId: 'user-1',
      voteType: 'up',
    });

    const result = await service.voteAiMessage('msg-1', 'up', 'user-1');

    expect(aiResponseVoteRepository.createOne).toHaveBeenCalledWith({
      aiConversationMessageId: 'msg-1',
      userId: 'user-1',
      voteType: 'up',
    });
    expect(aiResponseVoteRepository.updateOne).not.toHaveBeenCalled();
    expect(result).toMatchObject({ voteType: 'up' });
  });

  it('overwrites the existing vote row instead of creating a second one (ADR-0009: one row per message)', async () => {
    const { service, messageRepo, conversationRepo, aiResponseVoteRepository } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'msg-1', aiConversationId: 'conv-1' });
    // The acting user here is 'user-2', so the owning conversation is mocked as theirs.
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-2', conversationType: 'generate' });
    aiResponseVoteRepository.findByMessageId.mockResolvedValue({
      id: 'vote-1',
      aiConversationMessageId: 'msg-1',
      userId: 'user-1',
      voteType: 'up',
    });

    await service.voteAiMessage('msg-1', 'down', 'user-2');
    expect(aiResponseVoteRepository.updateOne).toHaveBeenCalledWith('vote-1', { voteType: 'down', userId: 'user-2' });
    expect(aiResponseVoteRepository.createOne).not.toHaveBeenCalled();
  });

  // IDOR regression (CRITICAL): a vote row is attached to another user's thread, so the
  // message's conversation must belong to the acting user.
  it('404s when the message belongs to a conversation owned by another user (ownership enforced)', async () => {
    const { service, messageRepo, conversationRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'msg-1', aiConversationId: 'conv-1' });
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-2', conversationType: 'generate' });

    await expect(service.voteAiMessage('msg-1', 'up', 'user-1')).rejects.toThrow(NotFoundException);
  });
});

/** @group platform */
describe('AiService.regenerateAiMessage', () => {
  it('rejects when parentMessageId is missing', async () => {
    const { service } = buildService();

    await expect(service.regenerateAiMessage(null, 'user-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the parent message does not exist', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue(null);

    await expect(service.regenerateAiMessage('user-msg-1', 'user-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects when the parent message is not part of the active (isLatest) branch', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'user-msg-1', aiConversationId: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'other-msg', messageType: 'user', content: 'hi' }]);

    await expect(service.regenerateAiMessage('user-msg-1', 'user-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('rejects when the parent message has no AI reply to regenerate', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'user-msg-1', aiConversationId: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'user-msg-1', messageType: 'user', content: 'Build me a CRM' },
    ]);

    await expect(service.regenerateAiMessage('user-msg-1', 'user-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it("rejects regenerating anything but the conversation's current last turn (ADR-0009)", async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'user-msg-1', aiConversationId: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'user-msg-1', messageType: 'user', content: 'Build me a CRM', parentId: null },
      { id: 'ai-msg-1', messageType: 'ai', content: 'Here is a PRD', parentId: 'user-msg-1' },
      { id: 'user-msg-2', messageType: 'user', content: 'Add a status field', parentId: null },
      { id: 'ai-msg-2', messageType: 'ai', content: 'Updated PRD', parentId: 'user-msg-2' },
    ]);

    await expect(service.regenerateAiMessage('user-msg-1', 'user-1', 'org-1')).rejects.toThrow(
      'Only the latest message in the conversation can be regenerated'
    );
  });

  it('marks the stale reply isLatest:false and creates a new sibling with the same parentId, built from the same history the original reply used', async () => {
    const { service, messageRepo, aiUtilService } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'user-msg-2', aiConversationId: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'user-msg-1', messageType: 'user', content: 'Build me a CRM', parentId: null },
      { id: 'ai-msg-1', messageType: 'ai', content: 'Here is a PRD', parentId: 'user-msg-1' },
      { id: 'user-msg-2', messageType: 'user', content: 'Add a status field', parentId: null },
      { id: 'ai-msg-2', messageType: 'ai', content: 'Updated PRD', parentId: 'user-msg-2' },
    ]);
    aiUtilService.AIGatewayGenerate.mockResolvedValue({ text: 'Regenerated PRD text' });
    messageRepo.createOne.mockResolvedValue({
      id: 'ai-msg-3',
      aiConversationId: 'conv-1',
      messageType: 'ai',
      content: 'Regenerated PRD text',
      parentId: 'user-msg-2',
      isLatest: true,
    });

    const result = await service.regenerateAiMessage('user-msg-2', 'user-1', 'org-1');

    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledWith(
      'openai',
      'regenerate-message',
      {
        messages: [
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: 'Build me a CRM' },
          { role: 'assistant', content: 'Here is a PRD' },
          { role: 'user', content: 'Add a status field' },
        ],
      },
      'org-1'
    );
    expect(messageRepo.updateOne).toHaveBeenCalledWith('ai-msg-2', { isLatest: false });
    expect(messageRepo.createOne).toHaveBeenCalledWith({
      aiConversationId: 'conv-1',
      messageType: 'ai',
      content: 'Regenerated PRD text',
      parentId: 'user-msg-2',
      isLatest: true,
    });
    expect(result).toMatchObject({ id: 'ai-msg-3', isLatest: true });
  });
});

/** @group platform */
describe('AiService.sendUserDocsMessage', () => {
  const buildLearnConversation = () => ({ id: 'conv-1', userId: 'user-1', appId: 'app-1', conversationType: 'learn' });

  it('answers from a freshly-assembled App inventory and persists the reply, over the same SSE contract as a Generate message', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, appInventoryService } = buildService();

    conversationRepo.findById.mockResolvedValue(buildLearnConversation());
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne
      .mockResolvedValueOnce({ id: 'user-msg-1' })
      .mockResolvedValueOnce({ id: 'ai-msg-1', content: 'Your app has 2 pages.' });
    appInventoryService.assemble.mockResolvedValue('App: CRM\n\nPages:\n- Home: Table "orders"');

    async function* chunks() {
      yield 'Your app has ';
      yield '2 pages.';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    const response = buildMockResponse();

    await service.sendUserDocsMessage(
      { conversationId: 'conv-1', content: 'What pages do I have?' },
      response as any,
      'user-1',
      'org-1'
    );

    expect(appInventoryService.assemble).toHaveBeenCalledWith('app-1', 'version-1');

    const [provider, operationId, promptBody, organizationId] = aiUtilService.AIGateway.mock.calls[0];
    expect(provider).toBe('openai');
    expect(operationId).toBe('send-docs-message');
    expect(organizationId).toBe('org-1');
    expect(promptBody.messages[1]).toEqual({ role: 'system', content: expect.stringContaining('App: CRM') });
    expect(promptBody.messages[promptBody.messages.length - 1]).toEqual({
      role: 'user',
      content: 'What pages do I have?',
    });

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'chunk', { content: 'Your app has ' });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', {
      message: { id: 'ai-msg-1', content: 'Your app has 2 pages.' },
    });
    expect(messageRepo.createOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageType: 'ai', content: 'Your app has 2 pages.', parentId: 'user-msg-1' })
    );
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('tells the assistant it cannot build here, and to point at Promote instead', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue(buildLearnConversation());
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });

    async function* chunks() {
      yield 'ok';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    await service.sendUserDocsMessage(
      { conversationId: 'conv-1', content: 'Add a customers table' },
      buildMockResponse() as any,
      'user-1',
      'org-1'
    );

    const [, , promptBody] = aiUtilService.AIGateway.mock.calls[0];
    expect(promptBody.messages[0].role).toBe('system');
    expect(promptBody.messages[0].content).toMatch(/cannot change this app/i);
    expect(promptBody.messages[0].content).toMatch(/Start building/i);
  });

  it('sends prior conversation history along with the new question', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue(buildLearnConversation());
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'm1', messageType: 'user', content: 'What queries exist?' },
      { id: 'm2', messageType: 'ai', content: 'One: list_orders.' },
    ]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-2' }).mockResolvedValueOnce({ id: 'ai-msg-2' });

    async function* chunks() {
      yield 'ok';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    await service.sendUserDocsMessage(
      { conversationId: 'conv-1', content: 'Which page uses it?' },
      buildMockResponse() as any,
      'user-1',
      'org-1'
    );

    const [, , promptBody] = aiUtilService.AIGateway.mock.calls[0];
    expect(promptBody.messages.slice(2)).toEqual([
      { role: 'user', content: 'What queries exist?' },
      { role: 'assistant', content: 'One: list_orders.' },
      { role: 'user', content: 'Which page uses it?' },
    ]);
  });

  it('surfaces an LLM failure as an SSE error the user can resend after, with no retry', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue(buildLearnConversation());
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' });
    aiUtilService.AIGateway.mockRejectedValue(new Error('LocalAI unreachable'));

    const response = buildMockResponse();

    await service.sendUserDocsMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', { message: 'LocalAI unreachable' });
    expect(aiUtilService.AIGateway).toHaveBeenCalledTimes(1);
    // The user's message only — no AI reply is persisted for a failed answer.
    expect(messageRepo.createOne).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('surfaces an inventory-assembly failure the same way, rather than answering ungrounded', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, appInventoryService } = buildService();

    conversationRepo.findById.mockResolvedValue(buildLearnConversation());
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' });
    appInventoryService.assemble.mockRejectedValue(new Error('Could not read the app'));

    const response = buildMockResponse();

    await service.sendUserDocsMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1');

    expect(aiUtilService.AIGateway).not.toHaveBeenCalled();
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', { message: 'Could not read the app' });
  });

  it('refuses a Generate conversation before writing any SSE header', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'generate',
    });

    const response = buildMockResponse();

    await expect(
      service.sendUserDocsMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'user-1', 'org-1')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(messageRepo.createOne).not.toHaveBeenCalled();
  });

  it('requires conversationId and content', async () => {
    const { service } = buildService();

    await expect(
      service.sendUserDocsMessage(
        { conversationId: '', content: 'Hi' } as any,
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.sendUserDocsMessage(
        { conversationId: 'conv-1', content: '' } as any,
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on an unknown conversation', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(
      service.sendUserDocsMessage(
        { conversationId: 'nope', content: 'Hi' },
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/** @group platform */
describe('AiService — Generate-only actions are unreachable from a Learn conversation', () => {
  const learnConversation = { id: 'conv-1', userId: 'user-1', appId: 'app-1', conversationType: 'learn' };

  it('refuses approvePrd, without opening an SSE stream or generating a plan', async () => {
    const { service, conversationRepo, aiUtilService, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue(learnConversation);

    const response = buildMockResponse();

    await expect(service.approvePrd('conv-1', 'some PRD', USER, PERMISSIONS, response as any)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
    expect(stepRepository.createOne).not.toHaveBeenCalled();
  });

  it('refuses rewindStep, undoing nothing', async () => {
    const { service, conversationRepo, agentsService, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue(learnConversation);

    await expect(service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(stepRepository.findById).not.toHaveBeenCalled();
    expect(agentsService.undoArtifact).not.toHaveBeenCalled();
  });

  it('refuses sendUserMessage, so a PRD is never proposed in a thread that could not approve it', async () => {
    const { service, conversationRepo, aiUtilService, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(learnConversation);

    await expect(
      service.sendUserMessage(
        { conversationId: 'conv-1', content: 'Build a CRM' },
        buildMockResponse() as any,
        'user-1',
        'org-1'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(aiUtilService.AIGateway).not.toHaveBeenCalled();
    expect(messageRepo.createOne).not.toHaveBeenCalled();
  });
});

/** @group platform */
describe('AiService.regenerateAiMessage — Learn conversations', () => {
  it('regenerates a Learn answer against the Learn prompt and a re-assembled inventory, not the PRD prompt', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, appInventoryService } = buildService();

    const question = { id: 'user-msg-1', messageType: 'user', content: 'What pages do I have?', parentId: null };
    const staleAnswer = { id: 'ai-msg-1', messageType: 'ai', content: 'Two.', parentId: 'user-msg-1' };

    messageRepo.findMessageById.mockResolvedValue(question);
    messageRepo.findLatestByConversationId.mockResolvedValue([question, staleAnswer]);
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      userId: 'user-1',
      appId: 'app-1',
      conversationType: 'learn',
    });
    appInventoryService.assemble.mockResolvedValue('App: CRM');
    aiUtilService.AIGatewayGenerate.mockResolvedValue({ text: 'Two: Home and Orders.' });
    messageRepo.createOne.mockResolvedValue({ id: 'ai-msg-2', isLatest: true });

    const result = await service.regenerateAiMessage('user-msg-1', 'user-1', 'org-1');

    const [, , promptBody] = aiUtilService.AIGatewayGenerate.mock.calls[0];
    expect(promptBody.messages[0].content).toMatch(/cannot change this app/i);
    expect(promptBody.messages[1].content).toContain('App: CRM');
    expect(promptBody.messages.slice(2)).toEqual([{ role: 'user', content: 'What pages do I have?' }]);

    expect(messageRepo.updateOne).toHaveBeenCalledWith('ai-msg-1', { isLatest: false });
    expect(result).toMatchObject({ id: 'ai-msg-2' });
  });
});

/** @group platform */
describe('AiService.promoteConversation', () => {
  const learnConversation = { id: 'learn-1', appId: 'app-1', userId: 'user-1', conversationType: 'learn' };
  const question = { id: 'q-1', messageType: 'user', content: 'How do orders get listed?', parentId: null };
  const answer = { id: 'a-1', messageType: 'ai', content: 'Through the list_orders query.', parentId: 'q-1' };

  const primePromote = () => {
    const built = buildService();
    built.conversationRepo.findById.mockResolvedValue(learnConversation);
    built.messageRepo.findLatestByConversationId.mockResolvedValue([question, answer]);
    built.aiUtilService.createNewConversation.mockResolvedValue({
      id: 'generate-1',
      appId: 'app-1',
      conversationType: 'generate',
      metadata: { handoff: true },
    });
    built.messageRepo.createOne.mockResolvedValue({ id: 'seed-1', messageType: 'user' });
    return built;
  };

  it('creates a NEW Generate conversation and never mutates the Learn one', async () => {
    const { service, aiUtilService, conversationRepo } = primePromote();

    const result = await service.promoteConversation('learn-1', 'a-1', 'user-1');

    expect(aiUtilService.createNewConversation).toHaveBeenCalledWith('user-1', 'app-1', 'generate', undefined, true);
    // The only conversation row updated is the new Generate one (its promotedFrom metadata) —
    // the Learn conversation is left exactly as it was (ADR-0012).
    expect(conversationRepo.updateOne).toHaveBeenCalledTimes(1);
    expect(conversationRepo.updateOne).toHaveBeenCalledWith('generate-1', {
      metadata: { handoff: true, promotedFromConversationId: 'learn-1' },
    });
    expect(result).toMatchObject({ id: 'generate-1', conversationType: 'generate' });
  });

  it('seeds the new conversation with the triggering Q&A only, not the whole Learn history', async () => {
    const { service, messageRepo } = primePromote();
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'old-q', messageType: 'user', content: 'Unrelated earlier question' },
      { id: 'old-a', messageType: 'ai', content: 'Unrelated earlier answer', parentId: 'old-q' },
      question,
      answer,
    ]);

    const result = await service.promoteConversation('learn-1', 'a-1', 'user-1');

    expect(messageRepo.createOne).toHaveBeenCalledTimes(1);
    const seed = messageRepo.createOne.mock.calls[0][0];
    expect(seed).toMatchObject({ aiConversationId: 'generate-1', messageType: 'user', isLatest: true });
    expect(seed.content).toContain('How do orders get listed?');
    expect(seed.content).toContain('Through the list_orders query.');
    expect(seed.content).not.toContain('Unrelated earlier');
    expect(result.messages).toEqual([{ id: 'seed-1', messageType: 'user' }]);
  });

  it('promotes the latest answer when no messageId is given', async () => {
    const { service, messageRepo } = primePromote();
    messageRepo.findLatestByConversationId.mockResolvedValue([
      question,
      answer,
      { id: 'q-2', messageType: 'user', content: 'And the totals?' },
      { id: 'a-2', messageType: 'ai', content: 'Computed in the table.', parentId: 'q-2' },
    ]);

    await service.promoteConversation('learn-1', undefined, 'user-1');

    expect(messageRepo.createOne.mock.calls[0][0].content).toContain('Computed in the table.');
  });

  it('refuses to promote a Generate conversation', async () => {
    const { service, conversationRepo, aiUtilService } = primePromote();
    conversationRepo.findById.mockResolvedValue({ ...learnConversation, conversationType: 'generate' });

    await expect(service.promoteConversation('learn-1', 'a-1', 'user-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(aiUtilService.createNewConversation).not.toHaveBeenCalled();
  });

  it("404s on another user's conversation", async () => {
    const { service, aiUtilService } = primePromote();

    await expect(service.promoteConversation('learn-1', 'a-1', 'someone-else')).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(aiUtilService.createNewConversation).not.toHaveBeenCalled();
  });

  it('refuses when there is no answer to promote', async () => {
    const { service, messageRepo, aiUtilService } = primePromote();
    messageRepo.findLatestByConversationId.mockResolvedValue([question]);

    await expect(service.promoteConversation('learn-1', undefined, 'user-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(aiUtilService.createNewConversation).not.toHaveBeenCalled();
  });
});

/** @group platform */
describe('AiService conversation types', () => {
  it('creates and lists both generate and learn conversations', async () => {
    const { service, aiUtilService } = buildService();

    await service.createConversation('user-1', 'app-1', 'learn', 'org-1');
    expect(aiUtilService.createNewConversation).toHaveBeenCalledWith('user-1', 'app-1', 'learn', undefined, undefined);

    await service.listConversations('app-1', 'user-1', 'learn');
    expect(aiUtilService.getConversationsList).toHaveBeenCalledWith('app-1', 'user-1', 'learn');

    await service.createConversation('user-1', 'app-1', 'generate', 'org-1');
    expect(aiUtilService.createNewConversation).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      'generate',
      undefined,
      undefined
    );
  });

  it('defaults an unspecified type to generate', async () => {
    const { service, aiUtilService } = buildService();

    await service.createConversation('user-1', 'app-1', undefined, 'org-1');

    expect(aiUtilService.createNewConversation).toHaveBeenCalledWith(
      'user-1',
      'app-1',
      'generate',
      undefined,
      undefined
    );
  });

  it('rejects an unsupported conversation type instead of persisting an unlistable row', async () => {
    const { service, aiUtilService } = buildService();

    await expect(service.createConversation('user-1', 'app-1', 'docs', 'org-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.listConversations('app-1', 'user-1', 'docs')).rejects.toBeInstanceOf(BadRequestException);
    expect(aiUtilService.createNewConversation).not.toHaveBeenCalled();
  });
});

describe('AiService.fixWithAi', () => {
  // The Error context PreviewBox assembles client-side: the failing expression, the
  // resolver's message, what the property/component are called, and the value the
  // property fell back to (CONTEXT.md's "Error context").
  const errorContext = {
    expression: '{{queries.getusers.data}}',
    errorMessage: 'queries.getusers is not defined',
    componentName: 'table1',
    componentType: 'Table',
    propertyName: 'Data',
    fallbackValue: [],
  };

  const suggestionToolCall = {
    toolCalls: [
      {
        toolName: 'proposeFix',
        args: {
          fixedValue: '{{queries.getUsers.data}}',
          explanation: 'The query name was misspelled - it is getUsers, not getusers.',
        },
      },
    ],
  };

  it('rejects when the failing expression is missing', async () => {
    const { service, aiUtilService } = buildService();

    await expect(service.fixWithAi({ ...errorContext, expression: '   ' }, 'org-1')).rejects.toThrow(
      BadRequestException
    );
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
  });

  it('rejects when the resolver error message is missing', async () => {
    const { service, aiUtilService } = buildService();

    await expect(service.fixWithAi({ ...errorContext, errorMessage: '' }, 'org-1')).rejects.toThrow(
      BadRequestException
    );
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
  });

  // A component's resolver can report an array of messages rather than a string. That is a
  // bad request, not a server fault — reaching `.trim()` on it would throw a TypeError and
  // surface to the user as a 500.
  it.each([
    ['an array', ['queries.getusers is not defined']],
    ['a number', 42],
    ['an object', { message: 'boom' }],
  ])('rejects a non-string error message (%s) with a 400', async (_label, errorMessage) => {
    const { service, aiUtilService } = buildService();

    await expect(service.fixWithAi({ ...errorContext, errorMessage } as any, 'org-1')).rejects.toThrow(
      BadRequestException
    );
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
  });

  it('rejects a non-string expression with a 400', async () => {
    const { service, aiUtilService } = buildService();

    await expect(service.fixWithAi({ ...errorContext, expression: ['{{a}}'] } as any, 'org-1')).rejects.toThrow(
      BadRequestException
    );
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
  });

  it('returns the single Suggestion the forced tool call produced', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(suggestionToolCall);

    const suggestion = await service.fixWithAi(errorContext, 'org-1');

    expect(suggestion).toEqual({
      fixedValue: '{{queries.getUsers.data}}',
      explanation: 'The query name was misspelled - it is getUsers, not getusers.',
    });
  });

  it('forces the proposeFix tool call and puts the whole Error context in the prompt', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(suggestionToolCall);

    await service.fixWithAi(errorContext, 'org-1');

    const [provider, operationId, promptBody, organizationId] = aiUtilService.AIGatewayGenerate.mock.calls[0];
    expect(provider).toBe('openai');
    expect(operationId).toBe('fix-with-ai');
    expect(organizationId).toBe('org-1');
    expect(promptBody.toolChoice).toEqual({ type: 'tool', toolName: 'proposeFix' });
    expect(promptBody.tools).toHaveProperty('proposeFix');

    const prompt = promptBody.messages[0].content;
    expect(prompt).toContain('{{queries.getusers.data}}');
    expect(prompt).toContain('queries.getusers is not defined');
    expect(prompt).toContain('table1');
    expect(prompt).toContain('Data');
  });

  // ADR-0014: a fix request is one-shot - it is not an AiConversation and leaves no trace.
  it('persists nothing', async () => {
    const { service, aiUtilService, messageRepo, conversationRepo, artifactRepository, stepRepository } =
      buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(suggestionToolCall);

    await service.fixWithAi(errorContext, 'org-1');

    expect(messageRepo.createOne).not.toHaveBeenCalled();
    expect(aiUtilService.createNewConversation).not.toHaveBeenCalled();
    expect(conversationRepo.updateOne).not.toHaveBeenCalled();
    expect(artifactRepository.createOne).not.toHaveBeenCalled();
    expect(stepRepository.createOne).not.toHaveBeenCalled();
  });

  it('fails loudly when the model answers without calling proposeFix', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue({ text: 'I think your query name is wrong', toolCalls: [] });

    await expect(service.fixWithAi(errorContext, 'org-1')).rejects.toThrow('did not produce a fix');
  });

  // A fallback value of `[]`/`0`/`false` is meaningful context, so it has to survive into the
  // prompt rather than being dropped by a truthiness check - while a genuinely absent one
  // must not render as "undefined" and invite the model to treat that as the intended value.
  it('omits the fallback line entirely when there is no fallback value', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(suggestionToolCall);

    await service.fixWithAi({ ...errorContext, fallbackValue: undefined }, 'org-1');

    const prompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    expect(prompt).not.toContain('undefined');
    expect(prompt.toLowerCase()).not.toContain('fell back to');
  });
});

describe('AiService.copilot', () => {
  // The Copilot context the query editor assembles client-side (CONTEXT.md): what the user
  // asked for, what is already in the editor, and enough about the editor to know what
  // language the answer has to be written in.
  const copilotContext = {
    prompt: 'fetch the users and return only the active ones',
    currentCode: 'return [];',
    language: 'javascript',
    dataSourceKind: 'runjs',
    appId: 'app-1',
  };

  const completionToolCall = {
    toolCalls: [
      {
        toolName: 'writeCode',
        args: {
          code: 'const users = await queries.getUsers.run();\nreturn users.filter((user) => user.active);',
          explanation: 'Runs the getUsers query and keeps only the rows whose active flag is set.',
        },
      },
    ],
  };

  it('rejects an empty prompt rather than asking the model to guess what to write', async () => {
    const { service, aiUtilService } = buildService();

    await expect(service.copilot({ ...copilotContext, prompt: '   ' }, 'org-1')).rejects.toThrow(BadRequestException);
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
  });

  // This endpoint takes a raw `@Body()`, so a non-string prompt is a bad request rather than
  // a TypeError inside `.trim()` surfacing to the user as a 500.
  it.each([
    ['an array', ['write a query']],
    ['a number', 42],
    ['an object', { text: 'write a query' }],
  ])('rejects a non-string prompt (%s) with a 400', async (_label, prompt) => {
    const { service, aiUtilService } = buildService();

    await expect(service.copilot({ ...copilotContext, prompt } as any, 'org-1')).rejects.toThrow(BadRequestException);
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
  });

  it('returns the single Completion the forced tool call produced', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    const completion = await service.copilot(copilotContext, 'org-1');

    expect(completion).toEqual({
      code: 'const users = await queries.getUsers.run();\nreturn users.filter((user) => user.active);',
      explanation: 'Runs the getUsers query and keeps only the rows whose active flag is set.',
    });
  });

  it('forces the writeCode tool call and puts the whole Copilot context in the prompt', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    await service.copilot(copilotContext, 'org-1');

    const [provider, operationId, promptBody, organizationId] = aiUtilService.AIGatewayGenerate.mock.calls[0];
    expect(provider).toBe('openai');
    expect(operationId).toBe('copilot');
    expect(organizationId).toBe('org-1');
    expect(promptBody.toolChoice).toEqual({ type: 'tool', toolName: 'writeCode' });
    expect(promptBody.tools).toHaveProperty('writeCode');

    const prompt = promptBody.messages[0].content;
    expect(prompt).toContain('fetch the users and return only the active ones');
    expect(prompt).toContain('return [];');
    expect(prompt).toContain('runjs');
  });

  // ADR-0016: the App inventory is what stops the model inventing query and component names.
  it('grounds the prompt in the App inventory rather than assembling a second context', async () => {
    const { service, aiUtilService, appInventoryService } = buildService();
    appInventoryService.assemble.mockResolvedValue('App: Test app\nQueries:\n- getUsers (tooljetdb)');
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    await service.copilot(copilotContext, 'org-1');

    expect(appInventoryService.assemble).toHaveBeenCalledWith('app-1', 'version-1');
    expect(aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content).toContain('getUsers (tooljetdb)');
  });

  // An ungrounded completion is worse than a grounded one but far better than an error: the
  // user still gets code for the language they are in, just without knowing the app's names.
  it('still answers when no appId is supplied, without assembling an inventory', async () => {
    const { service, aiUtilService, appInventoryService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    const completion = await service.copilot({ ...copilotContext, appId: undefined }, 'org-1');

    expect(completion.code).toContain('queries.getUsers.run()');
    expect(appInventoryService.assemble).not.toHaveBeenCalled();
  });

  // Same reasoning: an app whose inventory can't be read (no versions yet, a repository
  // fault) should still get a completion, unlike a Learn answer, which would be ungrounded
  // about the very thing it was asked.
  it('degrades to an ungrounded completion when the inventory cannot be assembled', async () => {
    const { service, aiUtilService, appInventoryService } = buildService();
    appInventoryService.assemble.mockRejectedValue(new Error('no versions'));
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    const completion = await service.copilot(copilotContext, 'org-1');

    expect(completion.code).toContain('queries.getUsers.run()');
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalled();
  });

  // ADR-0016 (following ADR-0014): one prompt in, one Completion out, no trace left behind.
  it('persists nothing', async () => {
    const { service, aiUtilService, messageRepo, conversationRepo, artifactRepository, stepRepository } =
      buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    await service.copilot(copilotContext, 'org-1');

    expect(messageRepo.createOne).not.toHaveBeenCalled();
    expect(aiUtilService.createNewConversation).not.toHaveBeenCalled();
    expect(conversationRepo.updateOne).not.toHaveBeenCalled();
    expect(artifactRepository.createOne).not.toHaveBeenCalled();
    expect(stepRepository.createOne).not.toHaveBeenCalled();
  });

  it('fails loudly when the model answers without calling writeCode', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue({ text: 'Sure, here is some code', toolCalls: [] });

    await expect(service.copilot(copilotContext, 'org-1')).rejects.toThrow('did not produce any code');
  });

  // An empty editor is the common case for this feature - it must not read as "the user's
  // existing code is the literal string 'undefined'", which would invite the model to keep it.
  it('omits the existing-code section entirely for an empty editor', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    await service.copilot({ ...copilotContext, currentCode: '   ' }, 'org-1');

    const prompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    expect(prompt).not.toContain('undefined');
    expect(prompt.toLowerCase()).not.toContain('already in the editor');
  });

  // A Completion replaces the whole editor, so a partially-shown body is the one thing the
  // prompt must never contain: the model would be told to preserve code it cannot see, and the
  // unseen part would disappear on Apply.
  it('sends a long body whole rather than trimming it behind the model’s back', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);
    const longBody = `// start marker\n${'const filler = 1;\n'.repeat(200)}// end marker`;

    await service.copilot({ ...copilotContext, currentCode: longBody }, 'org-1');

    const prompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    expect(prompt).toContain('// start marker');
    expect(prompt).toContain('// end marker');
    expect(prompt).not.toContain('truncated');
  });

  // Past the bound the code is dropped outright and the model is told it is writing blind, so
  // the user is warned in the explanation instead of silently losing the head of their body.
  it('declares an over-long body unseen instead of showing part of it', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);
    const hugeBody = `// start marker\n${'x'.repeat(25000)}\n// end marker`;

    await service.copilot({ ...copilotContext, currentCode: hugeBody }, 'org-1');

    const prompt = aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content;
    expect(prompt).not.toContain('// start marker');
    expect(prompt).not.toContain('// end marker');
    expect(prompt).toContain('too long to include');
    expect(prompt.toLowerCase()).toContain('warning');
  });

  // The language decides the syntax of a whole generated body, so an unrecognised or absent
  // one must not silently produce Python in a runjs editor.
  it('defaults to javascript when the editor reports no language', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(completionToolCall);

    await service.copilot({ ...copilotContext, language: undefined }, 'org-1');

    expect(aiUtilService.AIGatewayGenerate.mock.calls[0][2].messages[0].content).toContain('javascript');
  });
});

// Ticket #21: phases on the plan and skip during execution.
const conversationRepoDefaults = (conversationRepo, messageRepo) => {
  conversationRepo.findById.mockResolvedValue({
    id: 'conv-1',
    appId: 'app-1',
    userId: 'user-1',
    conversationType: 'generate',
  });
  messageRepo.findLatestByConversationId.mockResolvedValue([
    { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
  ]);
};

describe('AiService.approvePrd - phases (ticket #21)', () => {
  it("persists the planner's phase label on each Step and carries it on the plan SSE event", async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();
    conversationRepoDefaults(conversationRepo, messageRepo);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce({
      toolCalls: [
        {
          toolName: 'proposeStepPlan',
          args: {
            steps: [
              { type: 'CreateTable', description: 'Create a customers table', phase: 'Create data tables' },
              { type: 'CreateComponent', description: 'Create a Home page', phase: 'Build the interface' },
            ],
          },
        },
      ],
    });

    stepRepository.createOne
      .mockResolvedValueOnce({
        ...pendingStepLike('step-1', 0, 'CreateTable', 'Create a customers table'),
        phase: 'Create data tables',
      })
      .mockResolvedValueOnce({
        ...pendingStepLike('step-2', 1, 'CreateComponent', 'Create a Home page'),
        phase: 'Build the interface',
      });

    const response = buildMockResponse();
    // Execution stops at the first step (no per-step handler mocked for CreateComponent's
    // page creation) — this test only cares about the plan generation and its wire shape.
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any).catch(() => {});

    expect(stepRepository.createOne).toHaveBeenCalledTimes(2);
    expect(stepRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CreateTable', phase: 'Create data tables', status: 'pending' })
    );
    expect(stepRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CreateComponent', phase: 'Build the interface', status: 'pending' })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'plan', {
      steps: [
        expect.objectContaining({ id: 'step-1', phase: 'Create data tables' }),
        expect.objectContaining({ id: 'step-2', phase: 'Build the interface' }),
      ],
    });
  });

  it('persists a blank planner phase as no phase at all (null on the Step, absent on the wire)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();
    conversationRepoDefaults(conversationRepo, messageRepo);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce({
      toolCalls: [
        {
          toolName: 'proposeStepPlan',
          args: { steps: [{ type: 'CreateTable', description: 'Create a customers table', phase: '   ' }] },
        },
      ],
    });
    stepRepository.createOne.mockResolvedValue(pendingStepLike('step-1', 0, 'CreateTable', 'Create a customers table'));

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any).catch(() => {});

    expect(stepRepository.createOne).toHaveBeenCalledWith(expect.not.objectContaining({ phase: expect.anything() }));
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'plan',
      expect.objectContaining({
        steps: [expect.not.objectContaining({ phase: expect.anything() })],
      })
    );
  });

  const pendingStepLike = (id: string, order: number, type: string, description: string) => ({
    id,
    conversationId: 'conv-1',
    messageId: 'ai-msg-1',
    order,
    type,
    description,
    status: 'pending',
  });
});

// Ticket #21: rewind composes with skip — a skipped step has no Artifact to undo, and a
// rewind past it resets it to pending so a re-approved plan can include it again.
describe('AiService.rewindStep - skipped steps (ticket #21)', () => {
  it('passes over a skipped step without undoing anything, but resets it to pending', async () => {
    const { service, conversationRepo, agentsService, artifactRepository, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({
      id: 'conv-1',
      appId: 'app-1',
      userId: 'user-1',
      conversationType: 'generate',
    });
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateTable',
      status: 'succeeded',
    });
    stepRepository.findAfterOrder.mockResolvedValue([
      { id: 'step-2', conversationId: 'conv-1', type: 'CreateTable', status: 'skipped', artifactId: null },
      { id: 'step-3', conversationId: 'conv-1', type: 'CreateTable', status: 'succeeded', artifactId: 'artifact-3' },
    ]);
    artifactRepository.findById.mockResolvedValue({ id: 'artifact-3', content: { id: 'tjdb-1' } });

    await service.rewindStep('conv-1', 'step-1', 'user-1', 'org-1');

    // Only the succeeded step's artifact is undone.
    expect(agentsService.undoArtifact).toHaveBeenCalledTimes(1);
    expect(agentsService.undoArtifact).toHaveBeenCalledWith('CreateTable', 'version-1', 'org-1', { id: 'tjdb-1' });
    expect(artifactRepository.deleteOne).toHaveBeenCalledTimes(1);
    // The skipped step is reset to pending (a later approval may include it), with no
    // artifact fields to clear beyond the standard reset.
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-2', {
      status: 'pending',
      artifactId: null,
      errorMessage: null,
      attempts: 0,
    });
  });
});

describe('AiService.skipStep (ticket #21)', () => {
  const buildSkipWorld = () => {
    const world = buildService();
    world.conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    return world;
  };

  it('marks a pending step as skipped', async () => {
    const { service, stepRepository } = buildSkipWorld();
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      status: 'pending',
    });

    const result = await service.skipStep('conv-1', 'step-1', 'user-1');

    expect(result).toEqual({ skipped: 'step-1' });
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', { status: 'skipped' });
  });

  it('marks a running step as skipped (the execution loop discards its outcome at the next checkpoint)', async () => {
    const { service, stepRepository } = buildSkipWorld();
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      status: 'running',
    });

    const result = await service.skipStep('conv-1', 'step-1', 'user-1');

    expect(result).toEqual({ skipped: 'step-1' });
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', { status: 'skipped' });
  });

  it('refuses to skip a step that already succeeded', async () => {
    const { service, stepRepository } = buildSkipWorld();
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      status: 'succeeded',
    });

    await expect(service.skipStep('conv-1', 'step-1', 'user-1')).rejects.toThrow(BadRequestException);
    expect(stepRepository.updateOne).not.toHaveBeenCalled();
  });

  it('refuses to skip a step that failed (the plan already stopped; redo is rewind + re-approve)', async () => {
    const { service, stepRepository } = buildSkipWorld();
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      status: 'failed',
    });

    await expect(service.skipStep('conv-1', 'step-1', 'user-1')).rejects.toThrow(BadRequestException);
    expect(stepRepository.updateOne).not.toHaveBeenCalled();
  });

  it("refuses to skip a step that belongs to another user's conversation", async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'someone-else', conversationType: 'generate' });

    await expect(service.skipStep('conv-1', 'step-1', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('refuses to skip a step from a different conversation', async () => {
    const { service, stepRepository } = buildSkipWorld();
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-other',
      status: 'pending',
    });

    await expect(service.skipStep('conv-1', 'step-1', 'user-1')).rejects.toThrow(NotFoundException);
    expect(stepRepository.updateOne).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when conversationId or stepId is missing', async () => {
    const { service } = buildService();
    await expect(service.skipStep(undefined, 'step-1', 'user-1')).rejects.toThrow(BadRequestException);
    await expect(service.skipStep('conv-1', undefined, 'user-1')).rejects.toThrow(BadRequestException);
  });
});

describe('AiService.approvePrd - skip during execution (ticket #21)', () => {
  const twoStepPlanToolCall = () => ({
    toolCalls: [
      {
        toolName: 'proposeStepPlan',
        args: {
          steps: [
            { type: 'CreateTable', description: 'Create a customers table' },
            { type: 'CreateTable', description: 'Create an orders table' },
          ],
        },
      },
    ],
  });

  const oneColumnTable = (table_name: string) => ({
    table_name,
    columns: [{ column_name: 'id', data_type: 'serial', is_primary_key: true, is_not_null: true, is_unique: true }],
  });

  const createTableToolCall = (args: any) => ({
    toolCalls: [{ toolName: 'createTable', args }],
  });

  it('never starts a step the user skipped while it was pending, and reports it as step-skipped', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();
    conversationRepoDefaults(conversationRepo, messageRepo);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(twoStepPlanToolCall()).mockResolvedValueOnce(
      createTableToolCall(oneColumnTable('customers'))
    );

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateTable',
        description: 'Create an orders table',
        status: 'pending',
      });

    // The skip endpoint flipped step-2 to 'skipped' while step-1 was still executing.
    stepRepository.findById.mockImplementation((id: string) =>
      Promise.resolve({ id, status: id === 'step-2' ? 'skipped' : 'pending' })
    );

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers' },
      identifier: 'customers',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'step-skipped',
      expect.objectContaining({ step: 2, of: 2 })
    );
    // The skipped step never ran and never produced an Artifact.
    expect(stepRepository.updateOne).not.toHaveBeenCalledWith('step-2', expect.objectContaining({ status: 'running' }));
    expect(stepRepository.updateOne).not.toHaveBeenCalledWith(
      'step-2',
      expect.objectContaining({ status: 'succeeded' })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', { succeeded: 1, total: 2 });
  });

  it('discards a skipped-while-running step: its Artifact is undone and does not count as succeeded', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();
    conversationRepoDefaults(conversationRepo, messageRepo);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(twoStepPlanToolCall()).mockResolvedValueOnce(
      createTableToolCall(oneColumnTable('customers'))
    );

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateTable',
        description: 'Create an orders table',
        status: 'pending',
      });

    // Before execution: 'pending' (so the step starts). After the outcome lands: the skip
    // endpoint has marked it 'skipped' — the loop must undo whatever was just created.
    let step1Reads = 0;
    stepRepository.findById.mockImplementation((id: string) => {
      if (id !== 'step-1') return Promise.resolve(undefined);
      step1Reads += 1;
      return Promise.resolve({ id, status: step1Reads === 1 ? 'pending' : 'skipped' });
    });

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers' },
      identifier: 'customers',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    expect(agentsService.undoArtifact).toHaveBeenCalledWith('CreateTable', 'version-1', 'org-1', {
      id: 'tjdb-uuid',
      table_name: 'customers',
    });
    expect(artifactRepository.deleteOne).toHaveBeenCalledWith('artifact-1');
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-1', { artifactId: null });
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'step-skipped',
      expect.objectContaining({ step: 1, of: 2 })
    );
    // The discarded outcome never reaches priorResults, so the final tally is 0 of 2.
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', { succeeded: 0, total: 2 });
  });

  it('skip wins over retry (ticket #4): a step skipped while its retries ran is reported skipped, not failed, and the plan continues', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();
    conversationRepoDefaults(conversationRepo, messageRepo);

    aiUtilService.AIGatewayGenerate
      // plan
      .mockResolvedValueOnce(twoStepPlanToolCall())
      // attempt 1 of step-1 fails
      .mockRejectedValueOnce(new Error('boom'))
      // attempt 2 succeeds — but the user skipped the step while attempt 1 was running
      .mockResolvedValueOnce(createTableToolCall(oneColumnTable('customers')));

    stepRepository.createOne
      .mockResolvedValueOnce({
        id: 'step-1',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 0,
        type: 'CreateTable',
        description: 'Create a customers table',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        id: 'step-2',
        conversationId: 'conv-1',
        messageId: 'ai-msg-1',
        order: 1,
        type: 'CreateTable',
        description: 'Create an orders table',
        status: 'pending',
      });

    let step1Reads = 0;
    stepRepository.findById.mockImplementation((id: string) => {
      if (id !== 'step-1') return Promise.resolve({ id, status: 'skipped' });
      step1Reads += 1;
      // read 1: the pre-start checkpoint (still pending); read 2: the success path's
      // terminal-write guard, after the skip landed.
      return Promise.resolve({ id, status: step1Reads === 1 ? 'pending' : 'skipped' });
    });

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers' },
      identifier: 'customers',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', USER, PERMISSIONS, response as any);

    // Neither terminal status was written over 'skipped'...
    expect(stepRepository.updateOne).not.toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'succeeded' })
    );
    expect(stepRepository.updateOne).not.toHaveBeenCalledWith('step-1', expect.objectContaining({ status: 'failed' }));
    // ...the change attempt 2 made is undone...
    expect(agentsService.undoArtifact).toHaveBeenCalled();
    expect(artifactRepository.deleteOne).toHaveBeenCalledWith('artifact-1');
    // ...the plan continues to step-2 (itself pre-skipped, so it never starts), and the
    // tally counts neither step as succeeded.
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(
      response,
      'step-skipped',
      expect.objectContaining({ step: 1, of: 2 })
    );
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'done', { succeeded: 0, total: 2 });
  });
});

describe('AiService.generate-path prompt budget (ticket #58)', () => {
  // These endpoints force a tool call through AIGatewayGenerate (no SSE stream), so unlike the
  // chat paths they used to send the assembled prompt straight to the gateway — now they fit it
  // into the model's context window first, with the same system → messages priority order.
  const suggestionToolCall = {
    toolCalls: [{ toolName: 'proposeFix', args: { fixedValue: 'x', explanation: 'ok' } }],
  };

  it('fits the fix-with-ai prompt to the context window before sending it, and logs truncation', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(suggestionToolCall);
    aiUtilService.fitMessagesToContextWindowForOrg.mockReturnValue({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'trimmed' }],
      truncated: [
        { role: 'user', originalTokens: 100, keptTokens: 50, droppedTokens: 50, reason: 'content-truncated' },
      ],
    });

    await service.fixWithAi({ expression: 'a', errorMessage: 'b' }, 'org-1');

    expect(aiUtilService.fitMessagesToContextWindowForOrg).toHaveBeenCalledWith(
      'org-1',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('a') }),
      ])
    );
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledWith(
      'openai',
      'fix-with-ai',
      expect.objectContaining({
        system: 'system',
        messages: [{ role: 'user', content: 'trimmed' }],
      }),
      'org-1'
    );
  });

  it('keeps the trimmed system message rather than dropping it, even when the whole prompt overflows', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue(suggestionToolCall);
    aiUtilService.fitMessagesToContextWindowForOrg.mockReturnValue({ messages: [], truncated: [] });

    await service.fixWithAi({ expression: 'a', errorMessage: 'b' }, 'org-1');

    // Pass 1 of the fitter always keeps the first system message (possibly trimmed to ''), so the
    // budgeted prompt is never emptied out — the system prompt survives even a total overflow.
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledWith(
      'openai',
      'fix-with-ai',
      expect.objectContaining({ system: '' }),
      'org-1'
    );
  });

  it('fits the Copilot prompt to the context window before sending it', async () => {
    const { service, aiUtilService } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [{ toolName: 'writeCode', args: { code: 'x', explanation: 'ok' } }],
    });
    aiUtilService.fitMessagesToContextWindowForOrg.mockReturnValue({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'trimmed' }],
      truncated: [],
    });

    await service.copilot({ prompt: 'fetch the users', appId: 'app-1' }, 'org-1');

    expect(aiUtilService.fitMessagesToContextWindowForOrg).toHaveBeenCalledWith(
      'org-1',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user', content: expect.stringContaining('fetch the users') }),
      ])
    );
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledWith(
      'openai',
      'copilot',
      expect.objectContaining({
        system: 'system',
        messages: [{ role: 'user', content: 'trimmed' }],
      }),
      'org-1'
    );
  });

  it('fits the step-plan prompt to the context window before sending it', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, stepRepository } = buildService();
    aiUtilService.AIGatewayGenerate.mockResolvedValue({
      toolCalls: [{ toolName: 'proposeStepPlan', args: { steps: [{ type: 'createTable', description: 't' }] } }],
    });
    stepRepository.createOne.mockResolvedValue({ id: 'step-1', type: 'CreateTable', description: 't', status: 'pending' });
    aiUtilService.fitMessagesToContextWindowForOrg.mockReturnValue({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'trimmed' }],
      truncated: [],
    });

    // previewPlan loads a generate conversation of the caller's before planning.
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'ai-msg-1', messageType: 'ai', content: 'PRD' }]);

    await service.previewPlan('conv-1', USER, PERMISSIONS);

    expect(aiUtilService.fitMessagesToContextWindowForOrg).toHaveBeenCalledWith(
      'org-1',
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({ role: 'user' }),
      ])
    );
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledWith(
      'openai',
      'approve-prd-plan',
      expect.objectContaining({ system: 'system', messages: [{ role: 'user', content: 'trimmed' }] }),
      'org-1'
    );
  });
});
