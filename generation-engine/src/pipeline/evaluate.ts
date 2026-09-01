import { EvaluationVerdict, PipelineArtifacts, PipelineStage, StageContext } from './types';

/**
 * Parses a raw (LLM-judge-produced) evaluation payload into a typed verdict. Fails
 * closed: anything that isn't a well-formed `{ pass: boolean, reasons: string[] }`
 * object is treated as `pass: false` with a reason naming the parse failure — an
 * unparseable judge response must block the pipeline, not silently pass it through.
 * See docs/adr/0039 for why fail-closed is the pass/fail contract with the rest of the
 * pipeline (AC #4).
 */
export function parseEvaluationVerdict(raw: unknown): EvaluationVerdict {
  if (typeof raw !== 'object' || raw === null) {
    return { pass: false, reasons: ['evaluate stage: judge output was not an object'] };
  }

  const candidate = raw as { pass?: unknown; reasons?: unknown };
  if (typeof candidate.pass !== 'boolean') {
    return { pass: false, reasons: ['evaluate stage: judge output missing boolean "pass"'] };
  }

  const reasons = Array.isArray(candidate.reasons)
    ? candidate.reasons.filter((r): r is string => typeof r === 'string')
    : [];

  return { pass: candidate.pass, reasons };
}

export interface EvaluateStageDeps {
  judge(artifacts: PipelineArtifacts, ctx: StageContext): Promise<unknown>;
}

/**
 * Evaluate stage (ADR-0028's sixth and final stage) — LLM-as-judge post-processing.
 * Per ADR-0034, LLM output quality itself is checked manually with no eval
 * pipeline/golden dataset; what's unit-testable and tested here is the deterministic
 * half: parsing the judge's verdict into a typed, fail-closed pass/fail result
 * (`parseEvaluationVerdict`).
 *
 * The stage does NOT throw on a failing verdict — it records `evaluation` on the
 * artifacts and returns normally, leaving the fail/pass decision to the caller (the
 * route handler once #91's server-facing wiring extends past PRD to the full pipeline).
 * See docs/adr/0039 for the documented pass/fail contract (AC #4).
 */
export function buildEvaluateStage(deps: EvaluateStageDeps): PipelineStage {
  return {
    name: 'evaluate',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      const raw = await deps.judge(artifacts, ctx);
      const evaluation = parseEvaluationVerdict(raw);
      return { ...artifacts, evaluation };
    },
  };
}
