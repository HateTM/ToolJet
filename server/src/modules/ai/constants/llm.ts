/**
 * Provider/model defaults for AI Builder context-window accounting.
 *
 * These are the upstream advertised max-input-token values for the commonly-routed
 * model families. CE uses an OpenAI-compatible gateway by default, so the value here
 * is a safe ceiling for whatever model is configured through AI_MODEL / OPENAI_BASE_URL.
 */
export type LlmProvider = 'anthropic' | 'gemini' | 'grok' | 'openai' | 'openrouter' | 'tooljet_managed';

export const VALID_LLM_PROVIDERS: LlmProvider[] = [
  'anthropic',
  'gemini',
  'grok',
  'openai',
  'openrouter',
  'tooljet_managed',
];

export const DEFAULT_LLM_PROVIDER: LlmProvider = 'openai';

export const PROVIDER_CONTEXT_WINDOWS: Partial<Record<LlmProvider, number>> = {
  anthropic: 200_000,
  grok: 500_000,
  gemini: 1_000_000,
  openai: 128_000,
  openrouter: 128_000,
  tooljet_managed: 128_000,
};

/**
 * Per-message overhead used by the token budget estimator. It accounts for the
 * role/content framing that every message adds to the prompt, independent of the
 * text itself.
 */
export const MESSAGE_TOKEN_OVERHEAD = 4;

/**
 * Bytes-per-token ratio used by the fallback estimator. The exact ratio varies by
 * language, but 4 bytes/token is a widely-used rule of thumb for English/code and
 * keeps the estimate conservative enough to avoid accidental API overflows.
 */
export const DEFAULT_TOKEN_ESTIMATION_RATIO = 4;
