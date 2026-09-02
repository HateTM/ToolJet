jest.mock('@/_services/ai.service', () => ({
  aiService: {
    getKeySettings: jest.fn(),
    updateKey: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { aiService } from '@/_services/ai.service';
// eslint-disable-next-line import/first
import useAiProviderSettingsStore from '../ai-provider-settings.store';

const getState = () => useAiProviderSettingsStore.getState();

describe('aiProviderSettingsStore (ticket #65)', () => {
  const initialSnapshot = useAiProviderSettingsStore.getState();

  beforeEach(() => {
    useAiProviderSettingsStore.setState(initialSnapshot, true);
    jest.clearAllMocks();
  });

  it('starts loading with an env-config default form', () => {
    const state = getState();
    expect(state.isLoading).toBe(true);
    expect(state.settings).toBeNull();
    expect(state.form).toMatchObject({ provider: 'openai', model: '', apiKey: '', useEnvironmentConfig: true });
  });

  it('fetchSettings loads the org settings and seeds the form without the plaintext key', async () => {
    aiService.getKeySettings.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-opus',
      contextWindow: 200000,
      useEnvironmentConfig: false,
      hasKey: true,
      maskedApiKey: '••••••••',
    });

    await getState().fetchSettings();

    const state = getState();
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
    expect(state.settings.hasKey).toBe(true);
    expect(state.form).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus',
      apiKey: '',
      useEnvironmentConfig: false,
    });
  });

  it('fetchSettings records the error and stops loading on failure', async () => {
    aiService.getKeySettings.mockRejectedValue({ error: 'boom' });

    await getState().fetchSettings();

    const state = getState();
    expect(state.isLoading).toBe(false);
    expect(state.error).toBe('boom');
  });

  it('needsNewKeyForProviderSwitch is true only when switching provider without a new key', () => {
    useAiProviderSettingsStore.setState({
      settings: { provider: 'openai' },
      form: { provider: 'anthropic', model: '', apiKey: '', useEnvironmentConfig: false },
    });
    expect(getState().needsNewKeyForProviderSwitch()).toBe(true);

    useAiProviderSettingsStore.setState({
      settings: { provider: 'openai' },
      form: { provider: 'anthropic', model: '', apiKey: 'sk-new-key', useEnvironmentConfig: false },
    });
    expect(getState().needsNewKeyForProviderSwitch()).toBe(false);

    useAiProviderSettingsStore.setState({
      settings: { provider: 'openai' },
      form: { provider: 'openai', model: '', apiKey: '', useEnvironmentConfig: false },
    });
    expect(getState().needsNewKeyForProviderSwitch()).toBe(false);
  });

  it('save sends only the fields that matter and re-seeds the form from the response, clearing apiKey', async () => {
    useAiProviderSettingsStore.setState({
      form: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-secret', useEnvironmentConfig: false },
    });
    aiService.updateKey.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      contextWindow: 128000,
      useEnvironmentConfig: false,
      hasKey: true,
      maskedApiKey: '••••••••',
    });

    const result = await getState().save();

    expect(aiService.updateKey).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-4o',
      useEnvironmentConfig: false,
      apiKey: 'sk-secret',
    });
    expect(result).toEqual({ success: true });
    const state = getState();
    expect(state.isSaving).toBe(false);
    expect(state.form.apiKey).toBe('');
    expect(state.settings.hasKey).toBe(true);
  });

  it('save omits apiKey from the payload when no new key was entered', async () => {
    useAiProviderSettingsStore.setState({
      form: { provider: 'openai', model: 'gpt-4o', apiKey: '', useEnvironmentConfig: true },
    });
    aiService.updateKey.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      contextWindow: 128000,
      useEnvironmentConfig: true,
      hasKey: false,
      maskedApiKey: null,
    });

    await getState().save();

    expect(aiService.updateKey).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-4o',
      useEnvironmentConfig: true,
    });
  });

  it('canSave is false for a never-configured org that just defaults to env config — nothing to persist', () => {
    // Matches AiKeySettingsService.toSettings(null): provider is null, hasKey is false.
    useAiProviderSettingsStore.setState({
      settings: { provider: null, model: null, hasKey: false, maskedApiKey: null, useEnvironmentConfig: false },
      form: { provider: 'openai', model: '', apiKey: '', useEnvironmentConfig: true },
    });
    expect(getState().isFirstTimeConfig()).toBe(true);
    expect(getState().canSave()).toBe(false);
  });

  it('canSave is false for a never-configured org turning env config off without entering a key', () => {
    // Mirrors AiKeySettingsService.updateKey: `if (!row) { if (!dto.apiKey...) throw 400 }` —
    // unconditional on useEnvironmentConfig, so this save would 400 if it reached the backend.
    useAiProviderSettingsStore.setState({
      settings: { provider: null, model: null, hasKey: false, maskedApiKey: null, useEnvironmentConfig: false },
      form: { provider: 'openai', model: '', apiKey: '', useEnvironmentConfig: false },
    });
    expect(getState().needsApiKeyForFirstTimeConfig()).toBe(true);
    expect(getState().canSave()).toBe(false);
  });

  it('canSave is true for a never-configured org once an apiKey is entered', () => {
    useAiProviderSettingsStore.setState({
      settings: { provider: null, model: null, hasKey: false, maskedApiKey: null, useEnvironmentConfig: false },
      form: { provider: 'openai', model: '', apiKey: 'sk-first-key', useEnvironmentConfig: false },
    });
    expect(getState().canSave()).toBe(true);
  });

  it('canSave is true for a never-configured org that leaves useEnvironmentConfig on but supplies a key for later', () => {
    // Backend accepts creating the first row with useEnvironmentConfig=true as long as
    // provider+apiKey are present (AiKeySettingsService.updateKey has no such block).
    useAiProviderSettingsStore.setState({
      settings: { provider: null, model: null, hasKey: false, maskedApiKey: null, useEnvironmentConfig: false },
      form: { provider: 'openai', model: '', apiKey: 'sk-configure-for-later', useEnvironmentConfig: true },
    });
    expect(getState().canSave()).toBe(true);
  });

  it('canSave is true for an already-configured org toggling useEnvironmentConfig with no key change', () => {
    useAiProviderSettingsStore.setState({
      settings: {
        provider: 'openai',
        model: 'gpt-4o',
        hasKey: true,
        maskedApiKey: '••••••••',
        useEnvironmentConfig: false,
      },
      form: { provider: 'openai', model: 'gpt-4o', apiKey: '', useEnvironmentConfig: true },
    });
    expect(getState().isFirstTimeConfig()).toBe(false);
    expect(getState().canSave()).toBe(true);
  });

  it('save surfaces the backend error and keeps the form untouched', async () => {
    useAiProviderSettingsStore.setState({
      form: { provider: 'anthropic', model: '', apiKey: '', useEnvironmentConfig: false },
    });
    aiService.updateKey.mockRejectedValue({ error: 'apiKey is required when switching providers' });

    const result = await getState().save();

    expect(result).toEqual({ success: false, error: 'apiKey is required when switching providers' });
    expect(getState().error).toBe('apiKey is required when switching providers');
    expect(getState().isSaving).toBe(false);
  });
});
