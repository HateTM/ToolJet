import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { EncryptionService } from '@modules/encryption/service';
import { OrganizationAiKey } from '@entities/organization_ai_key.entity';
import { User } from '@entities/user.entity';
import { UserPermissions } from '@modules/ability/types';
import { UpdateAiKeyDto } from '../dto';
import { PROVIDER_CONTEXT_WINDOWS, VALID_LLM_PROVIDERS } from '../constants/llm';
import { OrganizationAiKeyRepository } from '../repositories/organization-ai-key.repository';
import { AiKeySettings, EffectiveAiConfig, IAiKeySettingsService } from '../interfaces/IAiKeySettingsService';

// Table/column the ciphertext lives in — EncryptionService derives the key from
// this pair, so they must match at decrypt time.
const ENCRYPTION_TABLE = 'organization_ai_keys';
const ENCRYPTION_COLUMN = 'encrypted_key';

/**
 * Ticket #59: org-scoped BYOK storage for AI Builder.
 *
 * The API key is stored encrypted (EncryptionService) and never leaves the
 * server in plaintext — API responses only ever carry a masked tail. Provider
 * and model changes take effect on the next AIGateway call, no restart needed,
 * because the config is re-resolved per request.
 */
@Injectable()
export class AiKeySettingsService implements IAiKeySettingsService {
  private readonly logger = new Logger(AiKeySettingsService.name);

  constructor(
    private readonly organizationAiKeyRepository: OrganizationAiKeyRepository,
    private readonly encryptionService: EncryptionService
  ) {}

  private assertAdmin(userPermissions: UserPermissions) {
    if (!userPermissions?.isAdmin && !userPermissions?.isSuperAdmin) {
      throw new ForbiddenException('Only workspace admins can manage AI provider settings');
    }
  }

  async getEffectiveOrgConfig(organizationId: string): Promise<EffectiveAiConfig | null> {
    const row = await this.organizationAiKeyRepository.findByOrganizationId(organizationId);
    if (!row || row.useEnvironmentConfig || !VALID_LLM_PROVIDERS.includes(row.provider as any)) {
      return null;
    }
    if (row.provider === 'tooljet_managed') {
      // Managed credits/wallet is an EE concept and is intentionally not ported
      // to CE (ticket #59) — treat it as "no org config".
      return null;
    }
    if (!row.model) {
      // An incomplete config (key stored but no model chosen yet) must not be
      // routed — the AI SDK would receive a null model and fail at call time.
      this.logger.warn(
        `[AiKeySettings] org config incomplete (no model) for organizationId=${organizationId}; falling back to env`
      );
      return null;
    }

    const apiKey = await this.encryptionService.decryptColumnValue(
      ENCRYPTION_TABLE,
      ENCRYPTION_COLUMN,
      row.encryptedKey
    );

    return {
      source: 'org',
      provider: row.provider,
      model: row.model,
      apiKey,
      contextWindow: row.contextWindow ?? PROVIDER_CONTEXT_WINDOWS[row.provider] ?? PROVIDER_CONTEXT_WINDOWS.openai,
    };
  }

  async getKeySettings(user: User, userPermissions: UserPermissions): Promise<AiKeySettings> {
    this.assertAdmin(userPermissions);
    const row = await this.organizationAiKeyRepository.findByOrganizationId(user.organizationId);
    return this.toSettings(row);
  }

  async updateKey(user: User, userPermissions: UserPermissions, dto: UpdateAiKeyDto): Promise<AiKeySettings> {
    this.assertAdmin(userPermissions);

    if (!VALID_LLM_PROVIDERS.includes(dto.provider as any)) {
      throw new BadRequestException(`Unsupported AI provider: ${dto.provider}`);
    }

    const row = await this.organizationAiKeyRepository.findByOrganizationId(user.organizationId);

    if (!row) {
      if (!dto.apiKey || !dto.provider) {
        throw new BadRequestException('provider and apiKey are required when configuring an organization key for the first time');
      }
    } else if (dto.provider !== row.provider && !dto.apiKey) {
      // The stored key belongs to the previous provider — silently reusing it
      // would only guarantee auth failures at call time.
      throw new BadRequestException('apiKey is required when switching providers');
    }

    const updated = row ?? this.organizationAiKeyRepository.create({ organizationId: user.organizationId });
    updated.provider = dto.provider;
    if (dto.model !== undefined) updated.model = dto.model;
    if (dto.useEnvironmentConfig !== undefined) updated.useEnvironmentConfig = dto.useEnvironmentConfig;
    if (dto.contextWindow !== undefined) updated.contextWindow = dto.contextWindow;

    if (dto.apiKey) {
      updated.encryptedKey = await this.encryptionService.encryptColumnValue(
        ENCRYPTION_TABLE,
        ENCRYPTION_COLUMN,
        dto.apiKey
      );
    }

    await this.organizationAiKeyRepository.save(updated);

    this.logger.log(
      `[AiKeySettings] provider=${updated.provider} model=${updated.model ?? '(inherited)'} useEnvironmentConfig=${updated.useEnvironmentConfig} organizationId=${user.organizationId}`
    );

    return this.toSettings(updated);
  }

  /**
   * API-safe projection of a key row: the plaintext/ciphertext key is never
   * included, only a masked tail so admins can tell which key is configured.
   */
  toSettings(row: OrganizationAiKey): AiKeySettings {
    if (!row) {
      return {
        provider: null,
        model: null,
        contextWindow: null,
        useEnvironmentConfig: false,
        hasKey: false,
        maskedApiKey: null,
      };
    }

    return {
      provider: row.provider,
      model: row.model,
      contextWindow: row.contextWindow,
      useEnvironmentConfig: row.useEnvironmentConfig,
      hasKey: !!row.encryptedKey,
      maskedApiKey: row.encryptedKey ? maskKey(row.encryptedKey) : null,
    };
  }
}

function maskKey(_encryptedKey: string): string {
  // The stored value is ciphertext — its tail is not a meaningful key fragment,
  // but it still identifies the configured record without exposing anything.
  return '••••••••';
}
