// server/test/modules/ai/unit/service.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiService } from '@modules/ai/service';

const buildMockAiUtilService = () => ({
  AIGateway: jest.fn(),
  AIGatewayGenerate: jest.fn(),
  sendSSE: jest.fn(),
  createNewConversation: jest.fn(),
  getConversationsList: jest.fn(),
  getConversationById: jest.fn(),
});

// Defaults to a Generate conversation so the tests that don't care about the type (most of
// them) don't each have to say so; Learn-conversation tests override `findById` themselves.
const buildMockConversationRepository = () => ({
  findById: jest.fn().mockResolvedValue({ id: 'conversation-1', appId: 'app-1', conversationType: 'generate' }),
  updateOne: jest.fn(),
});

const buildMockAppInventoryService = () => ({
  assemble: jest.fn().mockResolvedValue('App: Test app'),
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
});

// Defaults to one version so tests that don't care about appVersionId resolution (most of
// them) don't all have to mock it individually; tests that do care override it. createdAt
// is set explicitly (not left undefined) since resolveAppVersionId sorts by it.
const buildMockVersionRepository = () => ({
  getAllVersions: jest.fn().mockResolvedValue([{ id: 'version-1', createdAt: '2026-01-01T00:00:00.000Z' }]),
});

const buildMockResponse = () => ({
  setHeader: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
});

// Builds an AiService with all 9 constructor dependencies mocked, any of which can be
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

  const service = new AiService(
    aiUtilService as any,
    conversationRepo as any,
    messageRepo as any,
    agentsService as any,
    artifactRepository as any,
    stepRepository as any,
    versionRepository as any,
    aiResponseVoteRepository as any,
    appInventoryService as any
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
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

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'org-1');

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

  it('grounds every request in a PRD-focused system prompt (Generate conversations only ever propose a PRD, never build)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });

    async function* chunks() {
      yield 'ok';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    await service.sendUserMessage(
      { conversationId: 'conv-1', content: 'Build me a CRM' },
      buildMockResponse() as any,
      'org-1'
    );

    const [, , promptBody] = aiUtilService.AIGateway.mock.calls[0];
    expect(promptBody.messages[0]).toEqual({ role: 'system', content: expect.stringContaining('PRD') });
    expect(promptBody.messages[0].content).toContain('Product Requirements Document');
  });

  it('includes prior conversation history (as role-mapped messages) before the new message', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
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
      service.sendUserMessage({ conversationId: '', content: 'hi' } as any, buildMockResponse() as any, 'org-1')
    ).rejects.toThrow(BadRequestException);

    expect(conversationRepo.findById).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(
      service.sendUserMessage({ conversationId: 'conv-x', content: 'hi' }, buildMockResponse() as any, 'org-1')
    ).rejects.toThrow(NotFoundException);
  });

  it('sends an SSE error event and ends the response when the AI gateway fails mid-stream', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValue({ id: 'user-msg-1' });
    aiUtilService.AIGateway.mockRejectedValue(new Error('LLM gateway timed out'));

    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'org-1');

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', { message: 'LLM gateway timed out' });
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

  it('generates a step plan, persists Steps in order, and executes a single CreateTable step end to end', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
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

    agentsService.CreateTable.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });
    artifactRepository.createOne.mockResolvedValue({
      id: 'artifact-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers' },
      identifier: 'customers',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', 'org-1', response as any);

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
      columns: [
        {
          column_name: 'id',
          data_type: 'serial',
          constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
        },
      ],
    });
    expect(artifactRepository.createOne).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      content: { id: 'tjdb-uuid', table_name: 'customers' },
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
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
    await service.approvePrd('conv-1', 'PRD text', 'org-1', response as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
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
    await service.approvePrd('conv-1', 'PRD text', 'org-1', response as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
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
    await service.approvePrd('conv-1', 'PRD text', 'org-1', response as any);

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

    await expect(service.approvePrd('', 'PRD text', 'org-1', buildMockResponse() as any)).rejects.toThrow(
      BadRequestException
    );
    expect(conversationRepo.findById).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(service.approvePrd('conv-x', 'PRD text', 'org-1', buildMockResponse() as any)).rejects.toThrow(
      NotFoundException
    );
  });

  it('sends an SSE error event when the plan-generation call fails', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    aiUtilService.AIGatewayGenerate.mockRejectedValue(new Error('LLM gateway timed out'));

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', 'org-1', response as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

    expect(versionRepository.getAllVersions).toHaveBeenCalledWith('app-1');
    expect(agentsService.CreateComponent).toHaveBeenCalledWith('version-1', 'org-1', 'Page', { name: 'Orders' });
    expect(artifactRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({ content: { id: 'page-1', name: 'Orders' }, identifier: 'page-1' })
    );
  });

  it('picks the earliest-created version even when VersionRepository.getAllVersions returns them out of order', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository, versionRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

    expect(agentsService.CreateComponent).toHaveBeenCalledWith('version-oldest', 'org-1', 'Page', { name: 'Orders' });
  });

  it('creates a query from a CreateQuery step', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

    expect(agentsService.CreateQuery).toHaveBeenCalledWith('version-1', 'org-1', {
      name: 'list_orders',
      options: { operation: 'list_rows', table_id: 'table-uuid', list_rows: { limit: 100 } },
    });
  });

  it('retries an unrecognized component type (the model can self-correct, unlike an unsupported Step type)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateComponent', description: 'Create a page' }])
    )
      .mockResolvedValueOnce(componentToolCall({ type: 'Form', name: 'x' }))
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

    // Only called once — the first (Form) attempt never reached AgentsService at all.
    expect(agentsService.CreateComponent).toHaveBeenCalledTimes(1);
    expect(agentsService.CreateComponent).toHaveBeenCalledWith('version-1', 'org-1', 'Page', { name: 'Orders' });
    expect(stepRepository.updateOne).toHaveBeenCalledWith(
      'step-1',
      expect.objectContaining({ status: 'succeeded', attempts: 2 })
    );
  });

  it('rejects a Table step whose pageId does not match any Page created in this plan, then succeeds once the retry references the real one', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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
    await service.approvePrd('conv-1', 'PRD: build me an app to track orders', 'org-1', response as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

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

      conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

      await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

      expect(agentsService.CreateComponent).toHaveBeenNthCalledWith(2, 'version-1', 'org-1', type, props);
    }
  );

  it('creates a Form bound to a table created earlier in the plan, passing the real columns through', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository } =
      buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.approvePrd('conv-1', 'PRD text', 'org-1', buildMockResponse() as any);

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
});

/** @group platform */
describe('AiService.rewindStep', () => {
  it('rejects when conversationId or stepId is missing', async () => {
    const { service } = buildService();

    await expect(service.rewindStep(null, 'step-1', 'org-1')).rejects.toThrow(BadRequestException);
    await expect(service.rewindStep('conv-1', null, 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(service.rewindStep('conv-1', 'step-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('404s when the step does not exist, or belongs to a different conversation', async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
    stepRepository.findById.mockResolvedValue(null);

    await expect(service.rewindStep('conv-1', 'step-1', 'org-1')).rejects.toThrow(NotFoundException);

    stepRepository.findById.mockResolvedValue({ id: 'step-1', conversationId: 'conv-other', status: 'succeeded' });
    await expect(service.rewindStep('conv-1', 'step-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects rewinding to a step that never completed', async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
    stepRepository.findById.mockResolvedValue({ id: 'step-1', conversationId: 'conv-1', status: 'pending' });

    await expect(service.rewindStep('conv-1', 'step-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('undoes every succeeded step after the target, back to front, then resets each to pending', async () => {
    const { service, conversationRepo, stepRepository, artifactRepository, agentsService, versionRepository } =
      buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    const result = await service.rewindStep('conv-1', 'step-1', 'org-1');

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
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });

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

    const result = await service.rewindStep('conv-1', 'step-2', 'org-1');

    expect(stepRepository.findAfterOrder).toHaveBeenCalledWith('conv-1', 'msg-1', 1);
    // Only step-3 is undone/reset — step-1 (before the target) was never fetched at all.
    expect(stepRepository.updateOne).toHaveBeenCalledTimes(1);
    expect(stepRepository.updateOne).toHaveBeenCalledWith('step-3', expect.objectContaining({ status: 'pending' }));
    expect(agentsService.undoArtifact).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ rewoundTo: 'step-2', undone: ['step-3'] });
  });

  it("scopes 'steps after the target' to the target's own plan (messageId) — a separately approved PRD's steps are never touched", async () => {
    const { service, conversationRepo, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
    stepRepository.findById.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'msg-plan-2',
      order: 0,
      status: 'succeeded',
    });
    stepRepository.findAfterOrder.mockResolvedValue([]);

    await service.rewindStep('conv-1', 'step-1', 'org-1');

    // Scoped by this plan's own messageId, not just conversationId — an earlier plan's
    // (msg-plan-1) steps are a disjoint set findAfterOrder never sees.
    expect(stepRepository.findAfterOrder).toHaveBeenCalledWith('conv-1', 'msg-plan-2', 0);
  });

  it('resets a failed step after the target back to pending too, even though it has no artifact to undo', async () => {
    const { service, conversationRepo, stepRepository, artifactRepository, agentsService } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await service.rewindStep('conv-1', 'step-1', 'org-1');

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
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });
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

    await expect(service.rewindStep('conv-1', 'step-1', 'org-1')).rejects.toThrow(
      "Table can't be deleted, it is being used in app queries"
    );
    expect(artifactRepository.deleteOne).not.toHaveBeenCalled();
    expect(stepRepository.updateOne).not.toHaveBeenCalled();
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
    const { service, messageRepo, aiResponseVoteRepository } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'msg-1' });
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
});

/** @group platform */
describe('AiService.regenerateAiMessage', () => {
  it('rejects when parentMessageId is missing', async () => {
    const { service } = buildService();

    await expect(service.regenerateAiMessage(null, 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('404s when the parent message does not exist', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue(null);

    await expect(service.regenerateAiMessage('user-msg-1', 'org-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects when the parent message is not part of the active (isLatest) branch', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'user-msg-1', aiConversationId: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'other-msg', messageType: 'user', content: 'hi' }]);

    await expect(service.regenerateAiMessage('user-msg-1', 'org-1')).rejects.toThrow(BadRequestException);
  });

  it('rejects when the parent message has no AI reply to regenerate', async () => {
    const { service, messageRepo } = buildService();
    messageRepo.findMessageById.mockResolvedValue({ id: 'user-msg-1', aiConversationId: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'user-msg-1', messageType: 'user', content: 'Build me a CRM' },
    ]);

    await expect(service.regenerateAiMessage('user-msg-1', 'org-1')).rejects.toThrow(BadRequestException);
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

    await expect(service.regenerateAiMessage('user-msg-1', 'org-1')).rejects.toThrow(
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

    const result = await service.regenerateAiMessage('user-msg-2', 'org-1');

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
  const buildLearnConversation = () => ({ id: 'conv-1', appId: 'app-1', conversationType: 'learn' });

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

    await service.sendUserDocsMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'org-1');

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

    await service.sendUserDocsMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'org-1');

    expect(aiUtilService.AIGateway).not.toHaveBeenCalled();
    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', { message: 'Could not read the app' });
  });

  it('refuses a Generate conversation before writing any SSE header', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'generate' });

    const response = buildMockResponse();

    await expect(
      service.sendUserDocsMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'org-1')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(messageRepo.createOne).not.toHaveBeenCalled();
  });

  it('requires conversationId and content', async () => {
    const { service } = buildService();

    await expect(
      service.sendUserDocsMessage({ conversationId: '', content: 'Hi' } as any, buildMockResponse() as any, 'org-1')
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.sendUserDocsMessage({ conversationId: 'conv-1', content: '' } as any, buildMockResponse() as any, 'org-1')
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on an unknown conversation', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(null);

    await expect(
      service.sendUserDocsMessage({ conversationId: 'nope', content: 'Hi' }, buildMockResponse() as any, 'org-1')
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/** @group platform */
describe('AiService — Generate-only actions are unreachable from a Learn conversation', () => {
  const learnConversation = { id: 'conv-1', appId: 'app-1', conversationType: 'learn' };

  it('refuses approvePrd, without opening an SSE stream or generating a plan', async () => {
    const { service, conversationRepo, aiUtilService, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue(learnConversation);

    const response = buildMockResponse();

    await expect(service.approvePrd('conv-1', 'some PRD', 'org-1', response as any)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(response.setHeader).not.toHaveBeenCalled();
    expect(aiUtilService.AIGatewayGenerate).not.toHaveBeenCalled();
    expect(stepRepository.createOne).not.toHaveBeenCalled();
  });

  it('refuses rewindStep, undoing nothing', async () => {
    const { service, conversationRepo, agentsService, stepRepository } = buildService();
    conversationRepo.findById.mockResolvedValue(learnConversation);

    await expect(service.rewindStep('conv-1', 'step-1', 'org-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(stepRepository.findById).not.toHaveBeenCalled();
    expect(agentsService.undoArtifact).not.toHaveBeenCalled();
  });

  it('refuses sendUserMessage, so a PRD is never proposed in a thread that could not approve it', async () => {
    const { service, conversationRepo, aiUtilService, messageRepo } = buildService();
    conversationRepo.findById.mockResolvedValue(learnConversation);

    await expect(
      service.sendUserMessage({ conversationId: 'conv-1', content: 'Build a CRM' }, buildMockResponse() as any, 'org-1')
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
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', appId: 'app-1', conversationType: 'learn' });
    appInventoryService.assemble.mockResolvedValue('App: CRM');
    aiUtilService.AIGatewayGenerate.mockResolvedValue({ text: 'Two: Home and Orders.' });
    messageRepo.createOne.mockResolvedValue({ id: 'ai-msg-2', isLatest: true });

    const result = await service.regenerateAiMessage('user-msg-1', 'org-1');

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
