// server/test/modules/ai/unit/util.service.spec.ts

// Mock the AI SDK client — no real network call is made in this suite.
const mockLanguageModel = { modelId: 'mock-language-model' };
const mockProviderFn = jest.fn().mockReturnValue(mockLanguageModel);
const mockCreateOpenAI = jest.fn().mockReturnValue(mockProviderFn);
const mockStreamTextResult = { textStream: (async function* () {})() };
const mockStreamText = jest.fn().mockReturnValue(mockStreamTextResult);
const mockGenerateTextResult = { toolCalls: [] };
const mockGenerateText = jest.fn().mockResolvedValue(mockGenerateTextResult);

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => mockCreateOpenAI(...args),
}));

jest.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
  generateText: (...args: unknown[]) => mockGenerateText(...args),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiUtilService } from '@modules/ai/util.service';

const buildMockConversationRepository = () => ({
  findById: jest.fn(),
  createNewConversation: jest.fn(),
  setActive: jest.fn(),
  updateOne: jest.fn(),
});

const buildMockMessageRepository = () => ({
  findLatestByConversationId: jest.fn(),
});

/** @group platform */
describe('AiUtilService.AIGateway', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      OPENAI_BASE_URL: 'https://localai.internal/v1',
      OPENAI_API_KEY: 'test-api-key',
      AI_MODEL: 'llama-3-70b',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('builds the OpenAI-compatible provider from env vars, resolves AI_MODEL, and passes prompt_body through to streamText', async () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const promptBody = {
      messages: [{ role: 'user', content: 'Build me a table' }],
    };

    const result = await service.AIGateway('openai', 'create-component', promptBody, 'org-1');

    expect(mockCreateOpenAI).toHaveBeenCalledTimes(1);
    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://localai.internal/v1',
      apiKey: 'test-api-key',
    });

    expect(mockProviderFn).toHaveBeenCalledTimes(1);
    expect(mockProviderFn).toHaveBeenCalledWith('llama-3-70b');

    expect(mockStreamText).toHaveBeenCalledTimes(1);
    expect(mockStreamText).toHaveBeenCalledWith({
      model: mockLanguageModel,
      messages: promptBody.messages,
    });

    // Returns the model's (streamText) result as-is, so a later ticket can
    // pipe it into an SSE response.
    expect(result).toBe(mockStreamTextResult);
  });

  it('passes through tools and any other AI SDK call params in prompt_body', async () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const tools = { CreateTable: { description: 'create a table' } };
    const promptBody = { messages: [{ role: 'user', content: 'hi' }], tools };

    await service.AIGateway('openai', 'create-table', promptBody, 'org-1');

    expect(mockStreamText).toHaveBeenCalledWith({
      model: mockLanguageModel,
      messages: promptBody.messages,
      tools,
    });
  });

  it('rejects unsupported providers without calling the AI SDK', async () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

    await expect(service.AIGateway('anthropic', 'create-component', {}, 'org-1')).rejects.toThrow(
      /unsupported provider/i
    );

    expect(mockCreateOpenAI).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});

/** @group platform */
describe('AiUtilService.AIGatewayGenerate', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateText.mockResolvedValue(mockGenerateTextResult);
    process.env = {
      ...ORIGINAL_ENV,
      OPENAI_BASE_URL: 'https://localai.internal/v1',
      OPENAI_API_KEY: 'test-api-key',
      AI_MODEL: 'llama-3-70b',
    };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('builds the same OpenAI-compatible provider as AIGateway but calls generateText, not streamText', async () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const promptBody = {
      system: 'You design table schemas.',
      messages: [{ role: 'user', content: 'Create a customers table' }],
      tools: { createTable: { description: 'create a table' } },
      toolChoice: { type: 'tool', toolName: 'createTable' },
    };

    const result = await service.AIGatewayGenerate('openai', 'approve-prd-create-table', promptBody, 'org-1');

    expect(mockCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://localai.internal/v1',
      apiKey: 'test-api-key',
    });
    expect(mockGenerateText).toHaveBeenCalledWith({ model: mockLanguageModel, ...promptBody });
    expect(mockStreamText).not.toHaveBeenCalled();
    expect(result).toBe(mockGenerateTextResult);
  });

  it('rejects unsupported providers without calling the AI SDK', async () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

    await expect(service.AIGatewayGenerate('anthropic', 'approve-prd-plan', {}, 'org-1')).rejects.toThrow(
      /unsupported provider/i
    );

    expect(mockCreateOpenAI).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

/** @group platform */
describe('AiUtilService.sendSSE', () => {
  it('writes a standard SSE frame: event line, JSON data line, blank line', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const res = { write: jest.fn() };

    service.sendSSE(res as any, 'chunk', { content: 'hello' });

    expect(res.write).toHaveBeenCalledWith('event: chunk\ndata: {"content":"hello"}\n\n');
  });
});

/** @group platform */
describe('AiUtilService.createNewConversation', () => {
  it('reactivates and returns the given conversation when currentConversationId is provided', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    const result = await service.createNewConversation('user-1', 'app-1', 'generate', 'conv-1');

    expect(conversationRepo.setActive).toHaveBeenCalledWith('conv-1', 'app-1', 'user-1', 'generate');
    expect(conversationRepo.createNewConversation).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'conv-1', userId: 'user-1', conversationType: 'generate' });
  });

  it('reactivates a learn conversation the same way', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'learn-1', userId: 'user-1', conversationType: 'learn' });
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    const result = await service.createNewConversation('user-1', 'app-1', 'learn', 'learn-1');

    expect(conversationRepo.setActive).toHaveBeenCalledWith('learn-1', 'app-1', 'user-1', 'learn');
    expect(result).toEqual({ id: 'learn-1', userId: 'user-1', conversationType: 'learn' });
  });

  // conversationType is fixed for a conversation's whole lifetime (CONTEXT.md; ADR-0012 is built
  // on it). Reactivating is the one path that touches an existing conversation from outside, so
  // it's where a caller could otherwise re-label a Learn thread by continuing it as Generate.
  it('refuses to continue a conversation under a different conversationType', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'learn-1', userId: 'user-1', conversationType: 'learn' });
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    await expect(service.createNewConversation('user-1', 'app-1', 'generate', 'learn-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(conversationRepo.setActive).not.toHaveBeenCalled();
    expect(conversationRepo.createNewConversation).not.toHaveBeenCalled();
  });

  it('404s when the conversation to continue does not exist', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue(null);
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    await expect(service.createNewConversation('user-1', 'app-1', 'generate', 'gone')).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(conversationRepo.setActive).not.toHaveBeenCalled();
  });

  it('creates a brand new conversation when no currentConversationId is given', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.createNewConversation.mockResolvedValue({ id: 'conv-2', metadata: null });
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    const result = await service.createNewConversation('user-1', 'app-1', 'generate');

    expect(conversationRepo.createNewConversation).toHaveBeenCalledWith('user-1', 'app-1', 'generate');
    expect(conversationRepo.setActive).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'conv-2', metadata: null });
  });

  it('records handoff:true in metadata when creating a new conversation with handoff', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.createNewConversation.mockResolvedValue({ id: 'conv-3', metadata: null });
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    const result = await service.createNewConversation('user-1', 'app-1', 'generate', undefined, true);

    expect(conversationRepo.updateOne).toHaveBeenCalledWith('conv-3', { metadata: { handoff: true } });
    expect(result.metadata).toEqual({ handoff: true });
  });
});

/** @group platform */
describe('AiUtilService.getConversationById', () => {
  it('returns the conversation merged with its latest messages', async () => {
    const conversationRepo = buildMockConversationRepository();
    const messageRepo = buildMockMessageRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'user-1' });
    messageRepo.findLatestByConversationId.mockResolvedValue([{ id: 'msg-1' }]);
    const service = new AiUtilService(conversationRepo as any, messageRepo as any);

    const result = await service.getConversationById('conv-1', 'user-1');

    expect(result).toEqual({ id: 'conv-1', userId: 'user-1', messages: [{ id: 'msg-1' }] });
  });

  it('throws NotFoundException when the conversation does not exist', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue(null);
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    await expect(service.getConversationById('missing', 'user-1')).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when the conversation belongs to a different user', async () => {
    const conversationRepo = buildMockConversationRepository();
    conversationRepo.findById.mockResolvedValue({ id: 'conv-1', userId: 'someone-else' });
    const service = new AiUtilService(conversationRepo as any, buildMockMessageRepository() as any);

    await expect(service.getConversationById('conv-1', 'user-1')).rejects.toThrow(NotFoundException);
  });
});
