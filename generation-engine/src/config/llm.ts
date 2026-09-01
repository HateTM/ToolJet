/**
 * LLM provider vocabulary for the Generation engine.
 *
 * Mirrors `server/src/modules/ai/constants/llm.ts` — kept as a separate copy
 * rather than a shared package because the engine has no dependency on the
 * server's build (ADR-0029, stateless service). Any change here should be
 * checked against the server's copy; ADR-0038 documents why they exist in
 * both places.
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
