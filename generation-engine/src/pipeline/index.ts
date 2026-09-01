/**
 * Single import surface for the pipeline package (mirrors the `prompts/index.ts`
 * convention ADR-0030 establishes for #93's prompt library) — callers reach stages and
 * the orchestrator through here, not by importing individual stage files.
 */
export * from './types';
export * from './orchestrator';
export * from './classify';
export * from './prd';
export * from './lld';
export * from './feature-planner';
export * from './per-entity';
export * from './evaluate';

import { PipelineStage } from './types';
import { buildClassifyStage, ClassifyStageDeps } from './classify';
import { buildPrdStage, PrdStageDeps } from './prd';
import { buildLldStage, LldStageDeps } from './lld';
import { buildFeaturePlannerStage, FeaturePlannerStageDeps } from './feature-planner';
import { buildPerEntityStage, PerEntityStageDeps } from './per-entity';
import { buildEvaluateStage, EvaluateStageDeps } from './evaluate';

export interface DefaultPipelineDeps {
  classify: ClassifyStageDeps;
  prd: PrdStageDeps;
  lld: LldStageDeps;
  featurePlanner?: FeaturePlannerStageDeps;
  perEntity?: PerEntityStageDeps;
  evaluate: EvaluateStageDeps;
}

/**
 * Assembles the full ADR-0028 stage sequence in order:
 * classify -> PRD -> LLD -> feature-planner -> per-entity -> evaluate.
 *
 * Every LLM-calling dependency is required except `featurePlanner`/`perEntity`, whose
 * deterministic halves are useful standalone (see those files' own doc comments).
 * `runPipeline` (./orchestrator.ts) executes the result.
 */
export function buildDefaultPipeline(deps: DefaultPipelineDeps): PipelineStage[] {
  return [
    buildClassifyStage(deps.classify),
    buildPrdStage(deps.prd),
    buildLldStage(deps.lld),
    buildFeaturePlannerStage(deps.featurePlanner),
    buildPerEntityStage(deps.perEntity),
    buildEvaluateStage(deps.evaluate),
  ];
}
