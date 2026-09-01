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
 * Decision (ticket #110): the engine-side prd stage stays a plain, non-streaming LLM
 * call — `deps.generatePrd` in production (./llm-deps.ts) uses the PRD system prompt
 * from the prompt library (#93) with `generateText` on `ctx.llm`. It does NOT reuse
 * #91's `streamPrd`/SSE seam: streaming to the browser is the server proxy's concern
 * (ADR-0027), #91's `POST /generate/prd` route remains the streaming path, and #113
 * will stream the PRD artifact over SSE from the proxy. A dated note is appended to
 * ADR-0028.
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
