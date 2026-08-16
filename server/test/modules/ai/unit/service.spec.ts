// server/test/modules/ai/unit/service.spec.ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiService } from '@modules/ai/service';

const buildMockAiUtilService = () => ({
  AIGateway: jest.fn(),
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

const buildMockResponse = () => ({
  setHeader: jest.fn(),
  write: jest.fn(),
  end: jest.fn(),
});

/** @group platform */
describe('AiService.getCreditsBalance', () => {
  it('returns an enabled/unlimited result with no error, for any organization', async () => {
    const service = new AiService(
      buildMockAiUtilService() as any,
      buildMockConversationRepository() as any,
      buildMockMessageRepository() as any
    );

    const result = await service.getCreditsBalance('org-1');

    expect(result).toEqual({ aiFeaturesEnabled: true });
    expect(result.error).toBeUndefined();
  });

  it('does not read any credit-history repository (self-hosted CE has no credit accounting)', async () => {
    const service = new AiService(
      buildMockAiUtilService() as any,
      buildMockConversationRepository() as any,
      buildMockMessageRepository() as any
    );

    await expect(service.getCreditsBalance('org-2')).resolves.toEqual({ aiFeaturesEnabled: true });
  });
});

/** @group platform */
describe('AiService.sendUserMessage', () => {
  it('streams chunks over SSE and persists the final AI message on success', async () => {
    const aiUtilService = buildMockAiUtilService();
    const conversationRepo = buildMockConversationRepository();
    const messageRepo = buildMockMessageRepository();

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

    const service = new AiService(aiUtilService as any, conversationRepo as any, messageRepo as any);
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
    const aiUtilService = buildMockAiUtilService();
    const conversationRepo = buildMockConversationRepository();
    const messageRepo = buildMockMessageRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValueOnce({ id: 'user-msg-1' }).mockResolvedValueOnce({ id: 'ai-msg-1' });

    async function* chunks() {
      yield 'ok';
    }
    aiUtilService.AIGateway.mockResolvedValue({ textStream: chunks() });

    const service = new AiService(aiUtilService as any, conversationRepo as any, messageRepo as any);

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
    const aiUtilService = buildMockAiUtilService();
    const conversationRepo = buildMockConversationRepository();
    const messageRepo = buildMockMessageRepository();

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

    const service = new AiService(aiUtilService as any, conversationRepo as any, messageRepo as any);

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
    const conversationRepo = buildMockConversationRepository();
    const service = new AiService(
      buildMockAiUtilService() as any,
      conversationRepo as any,
      buildMockMessageRepository() as any
    );

    await expect(
      service.sendUserMessage({ conversationId: '', content: 'hi' } as any, buildMockResponse() as any, 'org-1')
    ).rejects.toThrow(BadRequestException);

    expect(conversationRepo.findById).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the conversation does not exist', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue(null);
    const service = new AiService(
      buildMockAiUtilService() as any,
      conversationRepo as any,
      buildMockMessageRepository() as any
    );

    await expect(
      service.sendUserMessage({ conversationId: 'conv-x', content: 'hi' }, buildMockResponse() as any, 'org-1')
    ).rejects.toThrow(NotFoundException);
  });

  it('sends an SSE error event and ends the response when the AI gateway fails mid-stream', async () => {
    const aiUtilService = buildMockAiUtilService();
    const conversationRepo = buildMockConversationRepository();
    const messageRepo = buildMockMessageRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([]);
    messageRepo.createOne.mockResolvedValue({ id: 'user-msg-1' });
    aiUtilService.AIGateway.mockRejectedValue(new Error('LLM gateway timed out'));

    const service = new AiService(aiUtilService as any, conversationRepo as any, messageRepo as any);
    const response = buildMockResponse();

    await service.sendUserMessage({ conversationId: 'conv-1', content: 'Hi' }, response as any, 'org-1');

    expect(aiUtilService.sendSSE).toHaveBeenCalledWith(response, 'error', { message: 'LLM gateway timed out' });
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});

/** @group platform */
describe('AiService conversation delegation', () => {
  it('createConversation delegates to AiUtilService.createNewConversation', async () => {
    const aiUtilService = buildMockAiUtilService();
    aiUtilService.createNewConversation.mockResolvedValue({ id: 'conv-1' });
    const service = new AiService(
      aiUtilService as any,
      buildMockConversationRepository() as any,
      buildMockMessageRepository() as any
    );

    const result = await service.createConversation('user-1', 'app-1', 'generate', 'org-1', 'conv-0', true);

    expect(aiUtilService.createNewConversation).toHaveBeenCalledWith('user-1', 'app-1', 'generate', 'conv-0', true);
    expect(result).toEqual({ id: 'conv-1' });
  });

  it('listConversations delegates to AiUtilService.getConversationsList', async () => {
    const aiUtilService = buildMockAiUtilService();
    aiUtilService.getConversationsList.mockResolvedValue([{ id: 'conv-1' }]);
    const service = new AiService(
      aiUtilService as any,
      buildMockConversationRepository() as any,
      buildMockMessageRepository() as any
    );

    const result = await service.listConversations('app-1', 'user-1', 'generate');

    expect(aiUtilService.getConversationsList).toHaveBeenCalledWith('app-1', 'user-1', 'generate');
    expect(result).toEqual([{ id: 'conv-1' }]);
  });

  it('getConversationById delegates to AiUtilService.getConversationById', async () => {
    const aiUtilService = buildMockAiUtilService();
    aiUtilService.getConversationById.mockResolvedValue({ id: 'conv-1', messages: [] });
    const service = new AiService(
      aiUtilService as any,
      buildMockConversationRepository() as any,
      buildMockMessageRepository() as any
    );

    const result = await service.getConversationById('conv-1', 'user-1');

    expect(aiUtilService.getConversationById).toHaveBeenCalledWith('conv-1', 'user-1');
    expect(result).toEqual({ id: 'conv-1', messages: [] });
  });
});
