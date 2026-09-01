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
 * Feature-planner stage (ADR-0028's fourth stage). Settled by ADR-0040 (#112): this
 * stage is engine-internal only — LLD -> FeaturePlan, the topological grouping/ordering
 * per-entity generation routes against. It does not subsume the fork's PRD -> Step-list
 * planner and does not call `step-plan`; that contract is produced by the separate
 * terminal `step-plan` stage (./step-plan.ts), which consumes this stage's ordering as a
 * hint. The two stay distinct so the internal routing concern and the user-facing,
 * previewable Step-list contract (ADR-0001/ADR-0004) can evolve independently.
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
