import { createOpenAI } from '@ai-sdk/openai';
import { resolveLanguageModel, resolveFromEnv } from '../src/config/provider';
import { VALID_LLM_PROVIDERS, LlmProvider } from '../src/config/llm';

jest.mock('@ai-sdk/openai', () => {
  const actual = jest.requireActual('@ai-sdk/openai');
  return {
    ...actual,
    createOpenAI: jest.fn(actual.createOpenAI),
  };
});

const mockedCreateOpenAI = createOpenAI as jest.MockedFunction<typeof createOpenAI>;

describe('resolveLanguageModel', () => {
  beforeEach(() => {
    mockedCreateOpenAI.mockClear();
  });

  it('builds an anthropic model — provider/modelId identify the SDK actually used', () => {
    const model = resolveLanguageModel({ provider: 'anthropic', model: 'test-model', apiKey: 'test-key' });
    expect(model.provider).toBe('anthropic.messages');
    expect(model.modelId).toBe('test-model');
    expect(mockedCreateOpenAI).not.toHaveBeenCalled();
  });

  it('builds a gemini model via createGoogleGenerativeAI', () => {
    const model = resolveLanguageModel({ provider: 'gemini', model: 'test-model', apiKey: 'test-key' });
    expect(model.provider).toBe('google.generative-ai');
    expect(model.modelId).toBe('test-model');
    expect(mockedCreateOpenAI).not.toHaveBeenCalled();
  });

  it('builds a grok model on the x.ai OpenAI-compatible base URL', () => {
    const model = resolveLanguageModel({ provider: 'grok', model: 'test-model', apiKey: 'test-key' });
    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('test-model');
    expect(mockedCreateOpenAI).toHaveBeenCalledWith({ baseURL: 'https://api.x.ai/v1', apiKey: 'test-key' });
  });

  it('builds an openrouter model on the openrouter OpenAI-compatible base URL', () => {
    const model = resolveLanguageModel({ provider: 'openrouter', model: 'test-model', apiKey: 'test-key' });
    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('test-model');
    expect(mockedCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
    });
  });

  it('builds a plain openai model, honoring a passed-through baseURL for self-hosted gateways', () => {
    const model = resolveLanguageModel({
      provider: 'openai',
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'https://example.invalid/v1',
    });
    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('test-model');
    expect(mockedCreateOpenAI).toHaveBeenCalledWith({ baseURL: 'https://example.invalid/v1', apiKey: 'test-key' });
  });

  it('rejects tooljet_managed — EE-only concept, never constructible in CE', () => {
    expect(() =>
      resolveLanguageModel({ provider: 'tooljet_managed' as LlmProvider, model: 'test-model', apiKey: 'test-key' })
    ).toThrow(/unsupported/i);
    expect(mockedCreateOpenAI).not.toHaveBeenCalled();
  });

  it('covers every VALID_LLM_PROVIDERS value across the six cases above', () => {
    const covered: LlmProvider[] = ['anthropic', 'gemini', 'grok', 'openrouter', 'openai', 'tooljet_managed'];
    expect(new Set(covered)).toEqual(new Set(VALID_LLM_PROVIDERS));
  });
});

describe('resolveFromEnv', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockedCreateOpenAI.mockClear();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('builds an openai-compatible model from OPENAI_BASE_URL/OPENAI_API_KEY/AI_MODEL', () => {
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1';
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.AI_MODEL = 'env-model';

    const model = resolveFromEnv();
    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('env-model');
    expect(mockedCreateOpenAI).toHaveBeenCalledWith({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'env-key',
    });
  });
});
