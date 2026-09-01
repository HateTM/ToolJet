// transit copy from PR #94 (feature/94-generation-engine-llm-config @ 60754490ca) — dedupe at merge
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { LlmProvider } from './llm';

/**
 * The resolved provider config the server hands to the engine per request —
 * either the org's decrypted BYOK settings or the env fallback, already
 * resolved before it crosses the wire. The engine never reads
 * `organization_ai_keys` or decrypts anything itself (ADR-0038).
 */
export interface EffectiveLlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
}

/**
 * Provider factory. Builds the AI SDK language model for an already-resolved
 * `EffectiveLlmConfig`. Pure function — no env reads, no I/O — so it can be
 * unit-tested per `LlmProvider` value without mocking a database.
 *
 * Mirrors `AiUtilService.buildProvider` in
 * `server/src/modules/ai/util.service.ts`: OpenAI-compatible providers
 * (openai/grok/openrouter) share `createOpenAI` with a per-provider base
 * URL; `baseURL` is honored for plain `openai` so self-hosted gateways
 * (e.g. LocalAI) keep working.
 *
 * `tooljet_managed` is a valid `LlmProvider` value but is never
 * constructible: it is CE's placeholder for an EE-only managed
 * credits/wallet concept, and the server never resolves an
 * `EffectiveLlmConfig` for it (`AiKeySettingsService.getEffectiveOrgConfig`
 * returns null for that row instead). Reaching this function with it is a
 * caller bug, and it throws the same way the server's `default:` arm does.
 */
export function resolveLanguageModel(config: EffectiveLlmConfig) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: config.apiKey })(config.model);
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model);
    case 'grok':
      return createOpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: config.apiKey })(config.model);
    case 'openrouter':
      return createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.apiKey })(config.model);
    case 'openai':
      return createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey })(config.model);
    default:
      throw new Error(`resolveLanguageModel: unsupported provider "${config.provider}"`);
  }
}

/**
 * Base 3-variable fallback (ADR-0031/ADR-0035): builds an OpenAI-compatible
 * model straight from `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL`, for
 * when no org `EffectiveLlmConfig` is available. Mirrors the tail of
 * `AiUtilService.resolveModel`.
 */
export function resolveFromEnv() {
  const openaiProvider = createOpenAI({
    baseURL: process.env.OPENAI_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY,
  });

  return openaiProvider(process.env.AI_MODEL as string);
}
