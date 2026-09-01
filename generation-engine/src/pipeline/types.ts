/**
 * Stage contract for the Generation engine's pipeline (ADR-0028): classify -> PRD -> LLD
 * -> feature-planner -> per-entity generation -> evaluate. Every stage reads and returns
 * the same accumulating `PipelineArtifacts` bag so the orchestrator (`./orchestrator.ts`)
 * can sequence an arbitrary stage list without knowing each stage's internal shape.
 *
 * This file intentionally has zero LLM/network code — it is the seam the six stage
 * modules and their (still-external, see per-file TODOs) prompt/catalog/provider
 * dependencies plug into.
 */

/** Classification stage output. See classify.ts for why this has no real prompt yet. */
export interface ClassificationResult {
  intent: 'build_app' | 'modify_app' | 'unsupported';
  confidence: number;
}

/**
 * One TooljetDB table definition, matching TooljetDbTableOperationsService's
 * `create_table` action payload shape as used by `server/src/modules/ai/services/
 * agents.service.ts` (`createTableComponent` / the `tables` payload comment above it).
 * Deliberately has no seed-data field — ADR-0028 scopes LLD to schema only, no seeding.
 */
export interface LldColumn {
  column_name: string;
  data_type: string;
  constraints_type?: {
    is_primary_key?: boolean;
    is_not_null?: boolean;
    is_unique?: boolean;
  };
  column_default?: string | number | boolean | null;
}

export interface LldForeignKey {
  column_name: string;
  references_table: string;
  references_column: string;
}

export interface LldTable {
  table_name: string;
  columns: LldColumn[];
  foreign_keys?: LldForeignKey[];
}

export interface LldSchema {
  tables: LldTable[];
}

/** One ordered unit of work the feature-planner hands to per-entity generation. */
export interface FeaturePlanItem {
  entityName: string;
  /** Tables this entity's generation depends on having already been created. */
  dependsOn: string[];
}

export interface FeaturePlan {
  items: FeaturePlanItem[];
}

export type EntityToolCallAction = 'create' | 'update';

/** One dispatched tool-call for a single entity (AC #3: distinct create/update calls). */
export interface EntityToolCall {
  entityName: string;
  action: EntityToolCallAction;
  toolName: string;
}

export interface EvaluationVerdict {
  pass: boolean;
  reasons: string[];
}

/**
 * The accumulating artifact bag every stage reads and extends. Optional fields are the
 * ones a given stage produces — populated in pipeline order, never read before their
 * producing stage has run.
 */
export interface PipelineArtifacts {
  prompt: string;
  classification?: ClassificationResult;
  prd?: string;
  lld?: LldSchema;
  featurePlan?: FeaturePlan;
  entityToolCalls?: EntityToolCall[];
  evaluation?: EvaluationVerdict;
}

export interface StageContext {
  organizationId: string;
  // TODO(#94): once the LLM-provider-resolution seam (generation-engine/src/config/
  // provider.ts, ADR-0035/0038) lands, an EffectiveLlmConfig belongs here so stages can
  // resolve a model without reaching into env vars themselves.
}

export interface PipelineStage {
  name: string;
  run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts>;
}
