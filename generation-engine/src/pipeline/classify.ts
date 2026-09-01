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
 * Classification stage (ADR-0028's first stage). The fork's own `classify()`
 * (server/src/modules/ai/services/agents.service.ts) throws "Method not implemented."
 * and has no real prompt text (#93's known gap #3) — there is nothing to port yet.
 *
 * TODO(#93): swap `deps.classify`'s caller for the real classify prompt once
 * `generation-engine/src/prompts/classify.ts` stops being a stub.
 * TODO(#92): the classification prompt is expected to reference the component/event
 * catalogs (ADR-0033) once it exists — wire `toPromptContext()` in here then.
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
