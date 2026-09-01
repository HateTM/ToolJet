import { PipelineArtifacts, PipelineStage, StageContext } from './types';

/**
 * Assembles the model input for the PRD stage from accumulated artifacts. Pure/
 * deterministic on purpose so it's testable without an LLM: given the same prompt and
 * classification, it always builds the same input string.
 */
export function buildPrdStageInput(artifacts: PipelineArtifacts): string {
  const classificationNote = artifacts.classification
    ? `\n\n[classification: ${artifacts.classification.intent}, confidence ${artifacts.classification.confidence}]`
    : '';
  return `${artifacts.prompt}${classificationNote}`;
}

export interface PrdStageDeps {
  /** Calls the LLM (or, in production, streams via #91's SSE proxy) and returns PRD text. */
  generatePrd(input: string, ctx: StageContext): Promise<string>;
}

/**
 * PRD stage (ADR-0028's second stage). Ticket #91 already ships a working, SSE-streamed
 * PRD generation path end-to-end (`POST /generate/prd`, `generation-engine/src/routes/
 * generate-prd.ts`, using the ported PRD prompt from #93) — this stage exists so the
 * pipeline orchestrator (`./orchestrator.ts`) can run PRD generation as one stage among
 * six for non-streaming/internal callers (e.g. batch regeneration), not to replace #91's
 * browser-facing streaming route.
 *
 * TODO(#91): once merged, `deps.generatePrd` should delegate to (or reuse the same
 * `streamText` call as) `generate-prd.ts`'s `streamPrd` seam, collecting the full text
 * instead of emitting SSE chunks, rather than duplicating the LLM call.
 * TODO(#93): use `prompts/prd.ts` (the ported system prompt) as the system prompt here —
 * not yet importable from this branch.
 */
export function buildPrdStage(deps: PrdStageDeps): PipelineStage {
  return {
    name: 'prd',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      const input = buildPrdStageInput(artifacts);
      const prd = await deps.generatePrd(input, ctx);
      return { ...artifacts, prd };
    },
  };
}
