import { immer } from 'zustand/middleware/immer';
import { create, zustandDevTools } from '@/_stores/utils';
import { aiService } from '@/_services/ai.service';

// CE provider list (ticket #65). `tooljet_managed` is deliberately excluded here — it is a
// managed-credits/wallet concept that AiKeySettingsService (ticket #59) treats as "no org
// config" and silently falls back to env, so surfacing it as a selectable provider in this
// admin UI would look like a working choice that quietly does nothing.
export const AI_PROVIDER_OPTIONS = ['openai', 'anthropic', 'gemini', 'grok', 'openrouter'];

const initialState = {
  isLoading: true,
  isSaving: false,
  error: null,
  // Last-fetched settings from GET /ai/key-settings — the source of truth for what's
  // actually saved (provider/model/useEnvironmentConfig/hasKey/maskedApiKey).
  settings: null,
  // The editable form. `apiKey` starts empty even when a key is already configured —
  // the server never returns the plaintext key, only a masked placeholder, so this
  // field represents "new key to save", not "current key".
  form: {
    provider: 'openai',
    model: '',
    apiKey: '',
    useEnvironmentConfig: true,
  },
};

const useAiProviderSettingsStore = create(
  zustandDevTools(
    immer((set, get) => ({
      ...initialState,

      fetchSettings: async () => {
        set((state) => {
          state.isLoading = true;
          state.error = null;
        });
        try {
          const settings = await aiService.getKeySettings();
          set((state) => {
            state.settings = settings;
            state.form = {
              provider: settings.provider || 'openai',
              model: settings.model || '',
              apiKey: '',
              useEnvironmentConfig: !!settings.useEnvironmentConfig,
            };
            state.isLoading = false;
          });
        } catch (error) {
          set((state) => {
            state.error = error?.error || error?.message || 'Failed to load AI provider settings';
            state.isLoading = false;
          });
        }
      },

      setField: (field, value) => {
        set((state) => {
          state.form[field] = value;
        });
      },

      // True once the form differs from what's saved in a way that would need a new
      // apiKey to actually take effect — switching provider without supplying a new key
      // is rejected by the backend (see AiKeySettingsService.updateKey), so the save
      // button's disabled state mirrors that up front instead of round-tripping an error.
      needsNewKeyForProviderSwitch: () => {
        const { settings, form } = get();
        return !!settings?.provider && form.provider !== settings.provider && !form.apiKey;
      },

      // `settings.provider` is only null when the org has no `organization_ai_keys` row yet
      // (see AiKeySettingsService.toSettings). The backend requires provider+apiKey
      // unconditionally in that case — even if useEnvironmentConfig is being set to true —
      // so a bare "enable env config" save on a never-configured org has nothing to persist.
      isFirstTimeConfig: () => !get().settings?.provider,

      needsApiKeyForFirstTimeConfig: () => get().isFirstTimeConfig() && !get().form.apiKey,

      // Saving is blocked by either guard above. Note there's no separate "first-time
      // config + useEnvironmentConfig=true + no key" branch here beyond
      // needsApiKeyForFirstTimeConfig: the backend accepts creating a first row with
      // useEnvironmentConfig=true as long as a provider+apiKey are supplied (a valid
      // "configured but not currently active" state), so blocking on the toggle alone
      // would reject a save the backend would happily accept.
      canSave: () => {
        const { needsNewKeyForProviderSwitch, needsApiKeyForFirstTimeConfig } = get();
        if (needsApiKeyForFirstTimeConfig()) return false;
        if (needsNewKeyForProviderSwitch()) return false;
        return true;
      },

      save: async () => {
        const { form } = get();
        set((state) => {
          state.isSaving = true;
          state.error = null;
        });
        try {
          const payload = {
            provider: form.provider,
            model: form.model || undefined,
            useEnvironmentConfig: form.useEnvironmentConfig,
          };
          if (form.apiKey) {
            payload.apiKey = form.apiKey;
          }
          const settings = await aiService.updateKey(payload);
          set((state) => {
            state.settings = settings;
            state.form = {
              provider: settings.provider || 'openai',
              model: settings.model || '',
              apiKey: '',
              useEnvironmentConfig: !!settings.useEnvironmentConfig,
            };
            state.isSaving = false;
          });
          return { success: true };
        } catch (error) {
          const message = error?.error || error?.message || 'Failed to save AI provider settings';
          set((state) => {
            state.error = message;
            state.isSaving = false;
          });
          return { success: false, error: message };
        }
      },

      reset: () => set(initialState),
    })),
    { name: 'ai-provider-settings-store' }
  )
);

export default useAiProviderSettingsStore;
