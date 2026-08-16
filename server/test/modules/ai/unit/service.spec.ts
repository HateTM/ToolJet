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

const buildMockConversationRepository = () => ({
  findById: jest.fn(),
});

const buildMockMessageRepository = () => ({
  findLatestByConversationId: jest.fn(),
  createOne: jest.fn(),
});

const buildMockAgentsService = () => ({
  CreateTable: jest.fn(),
});

const buildMockArtifactRepository = () => ({
  createOne: jest.fn(),
});

const buildMockStepRepository = () => ({
  createOne: jest.fn(),
  updateOne: jest.fn(),
});

const buildMockResponse = () => ({
  setHeader: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
});

// Builds an AiService with all 6 constructor dependencies mocked, any of which can be
// overridden. Centralizing this avoids repeating the full mock/constructor wiring in
// every test (and having to update all of them whenever the constructor's shape changes).
const buildService = (overrides: Partial<Record<string, any>> = {}) => {
  const aiUtilService = overrides.aiUtilService ?? buildMockAiUtilService();
  const conversationRepo = overrides.conversationRepo ?? buildMockConversationRepository();
  const messageRepo = overrides.messageRepo ?? buildMockMessageRepository();
  const agentsService = overrides.agentsService ?? buildMockAgentsService();
  const artifactRepository = overrides.artifactRepository ?? buildMockArtifactRepository();
  const stepRepository = overrides.stepRepository ?? buildMockStepRepository();

  const service = new AiService(
    aiUtilService as any,
    conversationRepo as any,
    messageRepo as any,
    agentsService as any,
    artifactRepository as any,
    stepRepository as any
  );

  return { service, aiUtilService, conversationRepo, messageRepo, agentsService, artifactRepository, stepRepository };
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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

  it('fails an unsupported step type immediately, without spending any retries on it (ADR-0006)', async () => {
    const { service, aiUtilService, conversationRepo, messageRepo, agentsService, stepRepository } = buildService();

    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([
      { id: 'ai-msg-1', messageType: 'ai', content: 'PRD text' },
    ]);
    messageRepo.createOne.mockResolvedValue({ id: 'failure-msg' });

    aiUtilService.AIGatewayGenerate.mockResolvedValueOnce(
      planToolCall([{ type: 'CreateQuery', description: 'Query the customers table' }])
    );
    stepRepository.createOne.mockResolvedValue({
      id: 'step-1',
      conversationId: 'conv-1',
      messageId: 'ai-msg-1',
      order: 0,
      type: 'CreateQuery',
      description: 'Query the customers table',
      status: 'pending',
    });

    const response = buildMockResponse();
    await service.approvePrd('conv-1', 'PRD text', 'org-1', response as any);

    // Only the plan-generation call happened — no per-step LLM call or CreateTable call for
    // a step type this ticket doesn't implement yet.
    expect(aiUtilService.AIGatewayGenerate).toHaveBeenCalledTimes(1);
    expect(agentsService.CreateTable).not.toHaveBeenCalled();
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
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
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
});
