// server/test/modules/ai/unit/util.service.spec.ts

// Mock the AI SDK client — no real network call is made in this suite.
const mockLanguageModel = { modelId: 'mock-language-model' };
const mockProviderFn = jest.fn().mockReturnValue(mockLanguageModel);
const mockCreateOpenAI = jest.fn().mockReturnValue(mockProviderFn);
const mockStreamTextResult = { textStream: (async function* () {})() };
const mockStreamText = jest.fn().mockReturnValue(mockStreamTextResult);

jest.mock('@ai-sdk/openai', () => ({
  createOpenAI: (...args: unknown[]) => mockCreateOpenAI(...args),
}));

jest.mock('ai', () => ({
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

import { AiUtilService } from '@modules/ai/util.service';

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
    const service = new AiUtilService();
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
    const service = new AiUtilService();
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
    const service = new AiUtilService();

    await expect(service.AIGateway('anthropic', 'create-component', {}, 'org-1')).rejects.toThrow(
      /unsupported provider/i
    );

    expect(mockCreateOpenAI).not.toHaveBeenCalled();
    expect(mockStreamText).not.toHaveBeenCalled();
  });
});
