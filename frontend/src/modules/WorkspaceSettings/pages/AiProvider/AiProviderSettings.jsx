import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { shallow } from 'zustand/shallow';
import Skeleton from 'react-loading-skeleton';
import { ButtonSolid } from '@/_ui/AppButton/AppButton';
import useAiProviderSettingsStore, { AI_PROVIDER_OPTIONS } from '../../stores/ai-provider-settings.store';

// Ticket #65: admin-only page for the AI Builder's LLM provider/key (ticket #59 backend).
// The route this page is mounted on is already wrapped in <AdminRoute> (see
// CEWorkspaceSettingsRoutes) and the API rejects non-admins independently
// (AiKeySettingsService.assertAdmin) — this component doesn't re-check admin-ness itself.
export default function AiProviderSettings() {
  const { t } = useTranslation();
  const {
    isLoading,
    isSaving,
    error,
    settings,
    form,
    fetchSettings,
    setField,
    save,
    needsNewKeyForProviderSwitch,
    isFirstTimeConfig,
    needsApiKeyForFirstTimeConfig,
    canSave: canSaveForm,
  } = useAiProviderSettingsStore(
    (state) => ({
      isLoading: state.isLoading,
      isSaving: state.isSaving,
      error: state.error,
      settings: state.settings,
      form: state.form,
      fetchSettings: state.fetchSettings,
      setField: state.setField,
      save: state.save,
      needsNewKeyForProviderSwitch: state.needsNewKeyForProviderSwitch,
      isFirstTimeConfig: state.isFirstTimeConfig,
      needsApiKeyForFirstTimeConfig: state.needsApiKeyForFirstTimeConfig,
      canSave: state.canSave,
    }),
    shallow
  );

  useEffect(() => {
    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const blockedByProviderSwitch = needsNewKeyForProviderSwitch();
  const firstTimeConfig = isFirstTimeConfig();
  const blockedByMissingFirstKey = needsApiKeyForFirstTimeConfig();
  const canSave = !isSaving && !isLoading && canSaveForm();

  const handleSave = async () => {
    const result = await save();
    if (result.success) {
      toast.success(t('workspaceSettings.aiProvider.saved', 'AI provider settings saved'), {
        position: 'top-center',
      });
    } else {
      toast.error(result.error, { position: 'top-center' });
    }
  };

  const statusLabel = settings?.useEnvironmentConfig
    ? t('workspaceSettings.aiProvider.sourceEnv', 'Using environment configuration')
    : settings?.hasKey
    ? t('workspaceSettings.aiProvider.sourceOrg', 'Using organization key')
    : t('workspaceSettings.aiProvider.sourceNone', 'No key configured');

  return (
    <div className="wrapper ai-provider-settings-page animation-fade tw-max-w-[640px]">
      <div className="card">
        <div className="card-header tw-justify-between">
          {isLoading ? (
            <Skeleton count={1} height={20} width={160} className="mb-1" />
          ) : (
            <div className="card-title" data-cy="ai-provider-card-title">
              {t('workspaceSettings.aiProvider.title', 'AI provider')}
            </div>
          )}
          {!isLoading && (
            <span className="tj-text-xsm inherited-tag" data-cy="ai-provider-status-label">
              {statusLabel}
            </span>
          )}
        </div>

        <div className="card-body">
          {isLoading ? (
            <Skeleton count={4} height={38} className="mb-3" />
          ) : (
            <form noValidate onSubmit={(e) => e.preventDefault()}>
              <div className="form-group tj-app-input mb-3">
                <label className="form-check form-switch" style={{ marginBottom: 0 }}>
                  <input
                    className="form-check-input"
                    type="checkbox"
                    data-cy="ai-provider-use-env-toggle"
                    checked={!!form.useEnvironmentConfig}
                    onChange={(e) => setField('useEnvironmentConfig', e.target.checked)}
                  />
                  <span className="form-check-label bold-text" data-cy="ai-provider-use-env-label">
                    {t(
                      'workspaceSettings.aiProvider.useEnvironmentConfig',
                      'Use environment configuration (OPENAI_BASE_URL / OPENAI_API_KEY / AI_MODEL)'
                    )}
                  </span>
                </label>
                <div className="tj-text-xxsm mt-1" data-cy="ai-provider-use-env-help">
                  {t(
                    'workspaceSettings.aiProvider.useEnvironmentConfigHelp',
                    'When enabled, generation uses the server-configured LLM regardless of the organization key below.'
                  )}
                </div>
              </div>

              <div className="form-group tj-app-input mb-3">
                <label className="form-label bold-text" data-cy="ai-provider-provider-label">
                  {t('workspaceSettings.aiProvider.provider', 'Provider')}
                </label>
                <select
                  className="form-select"
                  data-cy="ai-provider-provider-select"
                  value={form.provider}
                  onChange={(e) => setField('provider', e.target.value)}
                >
                  {AI_PROVIDER_OPTIONS.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group tj-app-input mb-3">
                <label className="form-label bold-text" data-cy="ai-provider-model-label">
                  {t('workspaceSettings.aiProvider.model', 'Model')}
                </label>
                <input
                  type="text"
                  className="form-control"
                  data-cy="ai-provider-model-input"
                  placeholder={t('workspaceSettings.aiProvider.modelPlaceholder', 'e.g. gpt-4o')}
                  value={form.model}
                  onChange={(e) => setField('model', e.target.value)}
                />
              </div>

              <div className="form-group tj-app-input mb-2">
                <label className="form-label bold-text" data-cy="ai-provider-api-key-label">
                  {t('workspaceSettings.aiProvider.apiKey', 'API key')}
                </label>
                <input
                  type="password"
                  className="form-control"
                  data-cy="ai-provider-api-key-input"
                  placeholder={
                    settings?.hasKey
                      ? settings.maskedApiKey
                      : t('workspaceSettings.aiProvider.apiKeyPlaceholder', 'Enter an API key')
                  }
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(e) => setField('apiKey', e.target.value)}
                />
                <div className="tj-text-xxsm mt-1" data-cy="ai-provider-api-key-help">
                  {settings?.hasKey
                    ? t(
                        'workspaceSettings.aiProvider.apiKeyHelpConfigured',
                        'A key is already configured. Leave blank to keep it, or enter a new one to replace it.'
                      )
                    : t('workspaceSettings.aiProvider.apiKeyHelp', 'Stored encrypted; never shown again after saving.')}
                </div>
              </div>

              {firstTimeConfig && blockedByMissingFirstKey && form.useEnvironmentConfig && (
                <div className="tj-text-xxsm mb-2" data-cy="ai-provider-no-org-key-yet">
                  {t(
                    'workspaceSettings.aiProvider.noKeyEnvOnly',
                    'Already using the environment configuration — nothing to save.'
                  )}
                </div>
              )}

              {firstTimeConfig && blockedByMissingFirstKey && !form.useEnvironmentConfig && (
                <div className="tj-text-xxsm danger-text-login mb-2" data-cy="ai-provider-first-key-warning">
                  {t(
                    'workspaceSettings.aiProvider.apiKeyRequiredFirstTime',
                    'Enter an API key to configure an organization key for the first time.'
                  )}
                </div>
              )}

              {!firstTimeConfig && blockedByProviderSwitch && (
                <div className="tj-text-xxsm danger-text-login mb-2" data-cy="ai-provider-switch-warning">
                  {t(
                    'workspaceSettings.aiProvider.switchProviderNeedsKey',
                    'Enter an API key for the new provider to switch — the previous key cannot be reused.'
                  )}
                </div>
              )}

              {error && (
                <div className="tj-text-xxsm danger-text-login mb-2" data-cy="ai-provider-error">
                  {error}
                </div>
              )}
            </form>
          )}
        </div>

        <div className="card-footer">
          <ButtonSolid
            onClick={handleSave}
            disabled={!canSave}
            isLoading={isSaving}
            data-cy="ai-provider-save-button"
            variant="primary"
            leftIcon="floppydisk"
            fill="#fff"
            iconWidth="20"
          >
            {t('globals.savechanges', 'Save')}
          </ButtonSolid>
        </div>
      </div>
    </div>
  );
}
