import { OrganizationAiKey } from '@entities/organization_ai_key.entity';
import { UserPermissions } from '@modules/ability/types';
import { User } from '@entities/user.entity';
import { UpdateAiKeyDto } from '../dto';

/**
 * Decrypted provider configuration used by AiUtilService.resolveModel —
 * either the org's BYOK settings (source 'org') or a signal to fall back to
 * the env-configured OpenAI-compatible gateway (source 'env').
 */
export interface EffectiveAiConfig {
  source: 'org' | 'env';
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  contextWindow: number;
}

export interface AiKeySettings {
  provider: string;
  model: string | null;
  contextWindow: number | null;
  useEnvironmentConfig: boolean;
  hasKey: boolean;
  maskedApiKey: string | null;
}

export interface IAiKeySettingsService {
  /**
   * Decrypts and returns the org's provider config, or `null` when the org has
   * no key row or explicitly switched back to the environment configuration.
   */
  getEffectiveOrgConfig(organizationId: string): Promise<EffectiveAiConfig | null>;

  getKeySettings(user: User, userPermissions: UserPermissions): Promise<AiKeySettings>;

  updateKey(user: User, userPermissions: UserPermissions, dto: UpdateAiKeyDto): Promise<AiKeySettings>;

  toSettings(row: OrganizationAiKey): AiKeySettings;
}
