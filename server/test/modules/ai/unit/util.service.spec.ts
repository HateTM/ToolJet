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
  const buildRes = (overrides: Record<string, any> = {}) => ({
    write: jest.fn(),
    flush: jest.fn(),
    ...overrides,
  });

  it('writes a standard SSE frame: event line, JSON data line, blank line', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const res = buildRes();

    service.sendSSE(res as any, 'chunk', { content: 'hello' });

    expect(res.write).toHaveBeenCalledWith('event: chunk\ndata: {"content":"hello"}\n\n');
    expect(res.flush).toHaveBeenCalled();
  });

  it('does not write when the response has already ended', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const res = buildRes({ writableEnded: true });

    service.sendSSE(res as any, 'chunk', { content: 'hello' });

    expect(res.write).not.toHaveBeenCalled();
    expect(res.flush).not.toHaveBeenCalled();
  });

  it('does not write when the response has been destroyed', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const res = buildRes({ destroyed: true });

    service.sendSSE(res as any, 'chunk', { content: 'hello' });

    expect(res.write).not.toHaveBeenCalled();
    expect(res.flush).not.toHaveBeenCalled();
  });
});

/** @group platform */
describe('AiUtilService.initSSE', () => {
  it('sets SSE headers, flushes them, and writes a heartbeat comment', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const res = {
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      write: jest.fn(),
      flush: jest.fn(),
    };

    service.initSSE(res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith(':heartbeat\n\n');
    expect(res.flush).toHaveBeenCalled();
  });
});

/** @group platform */
describe('AiUtilService.startHeartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends a heartbeat event every 5 seconds by default', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const res = { write: jest.fn(), flush: jest.fn(), once: jest.fn() };

    service.startHeartbeat(res as any);
    jest.advanceTimersByTime(5000);

    expect(res.write).toHaveBeenCalledTimes(1);
    const written = res.write.mock.calls[0][0];
    expect(written).toContain('event: heartbeat');
    expect(written).toContain('"timestamp":');
  });

  it('clears the interval when the response closes', () => {
    const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
    const closeHandlers: Array<() => void> = [];
    const res = {
      write: jest.fn(),
      flush: jest.fn(),
      once: jest.fn((_event: string, handler: () => void) => {
        closeHandlers.push(handler);
      }),
    };

    service.startHeartbeat(res as any);
    closeHandlers.forEach((handler) => handler());
    jest.advanceTimersByTime(10000);

    expect(res.write).not.toHaveBeenCalled();
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

/** @group platform */
describe('AiUtilService context window', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AI_CONTEXT_WINDOW;
    delete process.env.AI_TOKEN_ESTIMATION_RATIO;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('estimateTokenCount', () => {
    it('returns 0 for empty, null, or undefined content', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      expect(service.estimateTokenCount('')).toBe(0);
      expect(service.estimateTokenCount(null as any)).toBe(0);
      expect(service.estimateTokenCount(undefined as any)).toBe(0);
    });

    it('approximates tokens as UTF-8 byte length / 4 by default', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      const content = 'a'.repeat(40);

      // 40 bytes / 4 = 10 tokens, rounded up (already exact here).
      expect(service.estimateTokenCount(content)).toBe(10);
    });

    it('rounds partial token counts up', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      const content = 'a'.repeat(41);

      expect(service.estimateTokenCount(content)).toBe(11);
    });

    it('respects AI_TOKEN_ESTIMATION_RATIO', () => {
      process.env.AI_TOKEN_ESTIMATION_RATIO = '2';
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      // 40 bytes / 2 = 20 tokens.
      expect(service.estimateTokenCount('a'.repeat(40))).toBe(20);
    });
  });

  describe('getContextWindow', () => {
    it('returns the configured window from AI_CONTEXT_WINDOW when set', () => {
      process.env.AI_CONTEXT_WINDOW = '8192';
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      expect(service.getContextWindow('openai')).toBe(8192);
    });

    it('prefers the explicit configuredWindow argument over the env var', () => {
      process.env.AI_CONTEXT_WINDOW = '8192';
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      expect(service.getContextWindow('openai', 16384)).toBe(16384);
    });

    it('returns provider defaults when nothing is configured', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      expect(service.getContextWindow('openai')).toBe(128_000);
      expect(service.getContextWindow('anthropic')).toBe(200_000);
      expect(service.getContextWindow('grok')).toBe(500_000);
      expect(service.getContextWindow('gemini')).toBe(1_000_000);
    });

    it('falls back to the openai default for unknown providers', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      expect(service.getContextWindow('unknown-provider')).toBe(128_000);
    });

    it('honors small configured windows and floors only zero/negative values at 1', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      expect(service.getContextWindow('openai', 100)).toBe(100);
      process.env.AI_CONTEXT_WINDOW = '100';
      expect(service.getContextWindow('openai')).toBe(100);
      expect(service.getContextWindow('openai', 0)).toBe(1);
      process.env.AI_CONTEXT_WINDOW = '-5';
      expect(service.getContextWindow('openai')).toBe(1);
    });
  });

  describe('fitMessagesToContextWindow', () => {
    it('returns messages unchanged when they fit the budget', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
      ];

      const result = service.fitMessagesToContextWindow(messages, 'openai', 128_000);

      expect(result.messages).toEqual(messages);
      expect(result.truncated).toEqual([]);
    });

    it('keeps system and inventory messages, dropping oldest conversation turns first', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      // With the default 4-bytes-per-token ratio and MESSAGE_TOKEN_OVERHEAD of 4, token costs
      // here are: 'system prompt' = ceil(13/4)+4 = 8, 'app inventory' = 8, history turns = 7
      // each. A budget of 14 keeps the system prompt (8) and leaves 6 for the inventory, which
      // does not fit whole — it is content-truncated to 2 content tokens (8 chars). The two
      // history turns are dropped entirely.
      const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'system', content: 'app inventory' },
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' },
      ];

      const result = service.fitMessagesToContextWindow(messages, 'openai', 14);

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual(messages[0]);
      expect(result.messages[1].role).toBe('system');
      expect(result.messages[1].content.length).toBeLessThan(messages[1].content.length);
      const dropped = result.truncated.filter((t) => t.reason === 'message-dropped');
      expect(dropped).toHaveLength(2);
    });

    it('truncates an oversized single message instead of dropping it when it is the only content', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      const longContent = 'a'.repeat(100);
      const messages = [{ role: 'user', content: longContent }];

      // 100 bytes / 4 = 25 content tokens + 4 overhead = 29. Budget 20 leaves 16 content
      // tokens (64 bytes), so the message is content-truncated, not dropped.
      const result = service.fitMessagesToContextWindow(messages, 'openai', 20);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.length).toBeLessThan(longContent.length);
      expect(result.truncated[0].reason).toBe('content-truncated');
    });

    it('logs truncation details through the Nest logger', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

      const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'a'.repeat(200) },
      ];

      service.fitMessagesToContextWindow(messages, 'openai', 30);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('prompt truncated');
      warnSpy.mockRestore();
    });

    it('gracefully degrades when the budget is too small to hold even the system prompt', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);
      const messages = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'user message' },
      ];

      // 'system prompt' costs ceil(13/4)+4 = 8 tokens, so a budget of 4 cannot hold it: the
      // content is truncated to zero, the message survives as an empty system prompt, and the
      // user message is dropped.
      const result = service.fitMessagesToContextWindow(messages, 'openai', 4);

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content.length).toBeLessThan(messages[0].content.length);
      expect(result.truncated[0].reason).toBe('content-truncated');
    });

    it('handles an empty message list', () => {
      const service = new AiUtilService(buildMockConversationRepository() as any, buildMockMessageRepository() as any);

      const result = service.fitMessagesToContextWindow([], 'openai', 100);

      expect(result.messages).toEqual([]);
      expect(result.truncated).toEqual([]);
    });
  });
});
