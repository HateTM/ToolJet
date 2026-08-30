import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { VALID_LLM_PROVIDERS } from '../constants/llm';

/**
 * Ticket #59: payload of PATCH /ai/update-key. Only admins reach the handler
 * (guard is enforced in AiKeySettingsService). `provider` is required — it is
 * the primary routing decision — while the rest is optional so an admin can
 * update just the key or just the model.
 */
export class UpdateAiKeyDto {
  @IsIn(VALID_LLM_PROVIDERS, { message: `provider must be one of: ${VALID_LLM_PROVIDERS.join(', ')}` })
  provider: string;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'model must be at most 120 characters' })
  model?: string;

  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'apiKey must be at least 8 characters' })
  @MaxLength(4096, { message: 'apiKey must be at most 4096 characters' })
  apiKey?: string;

  @IsOptional()
  @IsBoolean()
  useEnvironmentConfig?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1, { message: 'contextWindow must be a positive integer' })
  contextWindow?: number;
}
