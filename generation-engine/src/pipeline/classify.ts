import { ClassificationResult, PipelineArtifacts, PipelineStage, StageContext } from './types';

const VALID_INTENTS: ClassificationResult['intent'][] = ['build_app', 'modify_app', 'unsupported'];

/**
 * Normalizes a raw (LLM-produced) classification payload into a `ClassificationResult`.
 * Anything that doesn't parse into a known intent, or carries an out-of-range
 * confidence, is treated as `unsupported` at confidence 0 — fail-closed, since a
 * misclassified `build_app`/`modify_app` would send the wrong stages downstream.
 */
export function parseClassification(raw: unknown): ClassificationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { intent: 'unsupported', confidence: 0 };
  }

  const candidate = raw as { intent?: unknown; confidence?: unknown };
  const intent = VALID_INTENTS.includes(candidate.intent as ClassificationResult['intent'])
    ? (candidate.intent as ClassificationResult['intent'])
    : 'unsupported';

  if (intent === 'unsupported') {
    return { intent: 'unsupported', confidence: 0 };
  }

  const rawConfidence = typeof candidate.confidence === 'number' ? candidate.confidence : 0;
  const confidence = Math.min(1, Math.max(0, rawConfidence));

  return { intent, confidence };
}

export interface ClassifyStageDeps {
  /** Calls the LLM and returns its raw (untrusted) classification payload. */
  classify(prompt: string, ctx: StageContext): Promise<unknown>;
}

/**
 * Classification stage (ADR-0028's first stage). The injected `deps.classify` is the
 * LLM-calling half; the real production implementation (./llm-deps.ts) calls the
 * classify system prompt from the prompt library (#93) via `ctx.llm`. The stage itself
 * stays prompt-agnostic — only `parseClassification` (deterministic, ADR-0034) lives here.
 */
export function buildClassifyStage(deps: ClassifyStageDeps): PipelineStage {
  return {
    name: 'classify',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      const raw = await deps.classify(artifacts.prompt, ctx);
      return { ...artifacts, classification: parseClassification(raw) };
    },
  };
}
