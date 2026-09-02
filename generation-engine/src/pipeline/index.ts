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
export * from './step-plan';
export * from './step-generation';
export * from './evaluate';
export * from './prompt-assembly';
export * from './llm-deps';

import { PipelineStage } from './types';
import { buildClassifyStage, ClassifyStageDeps } from './classify';
import { buildPrdStage, PrdStageDeps } from './prd';
import { buildLldStage, LldStageDeps } from './lld';
import { buildFeaturePlannerStage, FeaturePlannerStageDeps } from './feature-planner';
import { buildPerEntityStage, PerEntityStageDeps } from './per-entity';
import { buildStepPlanStage, StepPlanStageDeps } from './step-plan';
import { buildStepGenerationStage, StepGenerationStageDeps } from './step-generation';
import { buildEvaluateStage, EvaluateStageDeps } from './evaluate';

export interface DefaultPipelineDeps {
  classify: ClassifyStageDeps;
  prd: PrdStageDeps;
  lld: LldStageDeps;
  featurePlanner?: FeaturePlannerStageDeps;
  perEntity?: PerEntityStageDeps;
  stepPlan: StepPlanStageDeps;
  stepGeneration: StepGenerationStageDeps;
  evaluate: EvaluateStageDeps;
}

/**
 * Assembles the full ADR-0028 stage sequence as refined by ADR-0040 and ADR-0048:
 * classify -> PRD -> LLD -> feature-planner -> per-entity -> step-plan ->
 * step-generation -> evaluate.
 *
 * Every LLM-calling dependency is required except `featurePlanner`/`perEntity`, whose
 * deterministic halves are useful standalone (see those files' own doc comments).
 * `step-plan` proposes the fork's Step-list contract (ADR-0040) and `step-generation`
 * (ADR-0048) pre-generates the non-table steps' payloads; both must run before
 * evaluate, which judges the plan including the proposed steps. `runPipeline`
 * (./orchestrator.ts) executes the result.
 */
export function buildDefaultPipeline(deps: DefaultPipelineDeps): PipelineStage[] {
  return [
    buildClassifyStage(deps.classify),
    buildPrdStage(deps.prd),
    buildLldStage(deps.lld),
    buildFeaturePlannerStage(deps.featurePlanner),
    buildPerEntityStage(deps.perEntity),
    buildStepPlanStage(deps.stepPlan),
    buildStepGenerationStage(deps.stepGeneration),
    buildEvaluateStage(deps.evaluate),
  ];
}
