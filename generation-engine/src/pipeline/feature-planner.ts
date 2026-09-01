import { FeaturePlan, LldSchema, PipelineArtifacts, PipelineStage, StageContext } from './types';
import { topologicallyOrderTables } from './lld';

/**
 * Builds a `FeaturePlan` deterministically from an LLD schema: one plan item per table,
 * ordered so a table only appears after every table it foreign-keys into, and carrying
 * its direct dependency names for per-entity generation to route against.
 *
 * This is the routing half of the feature-planner stage — deterministic and fully
 * testable without an LLM. The stage also has an LLM-driven half (grouping/naming
 * features beyond a 1:1 table mapping), left to the injected `deps.planFeatures` below.
 */
export function buildFeaturePlanFromLld(lld: LldSchema): FeaturePlan {
  const ordered = topologicallyOrderTables(lld);
  return {
    items: ordered.map((table) => ({
      entityName: table.table_name,
      dependsOn: (table.foreign_keys ?? []).map((fk) => fk.references_table),
    })),
  };
}

export interface FeaturePlannerStageDeps {
  /**
   * Optional LLM-driven refinement of the deterministic table-derived plan (e.g.
   * grouping related tables into one user-facing feature). Defaults to the identity
   * function — the deterministic 1:1 table mapping — when omitted, so the stage is
   * usable standalone without an LLM dependency.
   */
  planFeatures?(plan: FeaturePlan, artifacts: PipelineArtifacts, ctx: StageContext): Promise<FeaturePlan>;
}

/**
 * Feature-planner stage (ADR-0028's fourth stage), new with no fork precedent.
 *
 * OPEN QUESTION (per #93's known gap #2, unresolved by that ticket and not settled
 * here): whether this stage subsumes the fork's existing PRD -> Step-list planner
 * (`prompts/step-plan.ts`, ported verbatim from `server/src/modules/ai/service.ts`) or
 * is a separate stage that runs before it. This implementation treats feature-planner as
 * LLD -> FeaturePlan only and does NOT call `step-plan` — left for whichever ticket
 * settles that question, flagged again here rather than guessed.
 */
export function buildFeaturePlannerStage(deps: FeaturePlannerStageDeps = {}): PipelineStage {
  return {
    name: 'feature-planner',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      if (!artifacts.lld) {
        throw new Error('feature-planner stage requires artifacts.lld (LLD stage must run first)');
      }

      const deterministicPlan = buildFeaturePlanFromLld(artifacts.lld);
      const featurePlan = deps.planFeatures
        ? await deps.planFeatures(deterministicPlan, artifacts, ctx)
        : deterministicPlan;

      return { ...artifacts, featurePlan };
    },
  };
}
