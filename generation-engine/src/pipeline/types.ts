/**
 * Stage contract for the Generation engine's pipeline (ADR-0028 as refined by ADR-0040
 * and ADR-0048): classify -> PRD -> LLD -> feature-planner -> per-entity -> step-plan ->
 * step-generation -> evaluate. Every stage reads and returns the same accumulating
 * `PipelineArtifacts` bag so the orchestrator (`./orchestrator.ts`) can sequence an
 * arbitrary stage list without knowing each stage's internal shape.
 *
 * This file intentionally has zero LLM/network code — it is the seam the eight stage
 * modules and their prompt/catalog/provider dependencies plug into.
 */
import { EffectiveLlmConfig } from '../config/provider';

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

/**
 * The `update_table` tool-call payload (ADR-0041): a full-replace of the table's column
 * definition. `columns` is the complete desired list, in the same shape the fork's
 * `create_table` tool call already uses (the planner's `PlannedTableColumn` /
 * `tableDefinitionObject` contract); `renames` is an optional explicit old->new
 * column-name map so a rename moves data instead of inferring drop+add. Foreign keys
 * and indexes are out of scope for v1 (ADR-0041, Consequences).
 */
export interface UpdateTableCallPayload {
  table_name: string;
  columns: PlannedTableColumn[];
  renames?: Record<string, string>;
}

/** One dispatched tool-call for a single entity (AC #3: distinct create/update calls). */
export interface EntityToolCall {
  entityName: string;
  action: EntityToolCallAction;
  toolName: string;
  /** The full-replace payload for `update` calls (ADR-0041); validated by validateUpdateTableCall. */
  payload?: UpdateTableCallPayload;
}

export interface EvaluationVerdict {
  pass: boolean;
  reasons: string[];
}

/**
 * The fork's v1 Step vocabulary (ADR-0002), exactly `StepType` in
 * `server/src/entities/step.entity.ts` / the `STEP_TYPES` const in
 * `server/src/modules/ai/service.ts`. Step-plan (ADR-0040) proposes from this list and
 * nothing else.
 */
export const STEP_TYPES = [
  'CreateTable',
  'UpdateTable',
  'CreateQuery',
  'CreateComponent',
  'UpdateComponent',
  'DeleteComponent',
  'MoveComponent',
  'UpdateQuery',
  'DeleteQuery',
  'GenerateEvent',
] as const;

export type StepType = (typeof STEP_TYPES)[number];

/**
 * The planner-proposed table definition riding a `CreateTable` step — the fork's
 * `tableDefinitionObject` shape (`server/src/modules/ai/service.ts`), which is what the
 * schema Preview renders and `executeCreateTableStep` creates verbatim (ADR-0020). Note
 * this is the planner's own shape (is_primary_key/is_not_null/is_unique), not the LLD
 * stage's `LldColumn` (constraints_type) — they are different contracts on purpose.
 */
export interface PlannedTableColumn {
  column_name: string;
  data_type: string;
  is_primary_key: boolean;
  is_not_null: boolean;
  is_unique: boolean;
}

export interface PlannedTableDefinition {
  table_name: string;
  columns: PlannedTableColumn[];
  /** Shape owned by the fork's planner contract; validated loosely here (see step-plan.ts). */
  foreign_keys?: Array<Record<string, unknown>>;
  indexes?: Array<Record<string, unknown>>;
}

/** One proposed row of planner-proposed seed data (ADR-0024): column name -> primitive value. */
export type PlannedSeedRow = Record<string, unknown>;

/**
 * One proposed build step — a member of the fork's Step-list contract
 * (ADR-0001/ADR-0004), matching `proposeStepPlanTool`'s per-step shape.
 */
export interface ProposedStep {
  type: StepType;
  description: string;
  /** Planner-proposed table definition for `CreateTable` steps (ADR-0020); optional. */
  table?: PlannedTableDefinition;
  /** Planner-proposed seed rows for `CreateTable` steps (ADR-0024); optional. */
  seed_rows?: PlannedSeedRow[];
  /** Planner-assigned phase name (ADR-0021); optional, falls back to one unnamed group. */
  phase?: string;
  /**
   * Existing component/query id a modify step targets (ADR-0054): set by the planner on
   * update, delete and move steps when the caller supplied an app inventory, so the
   * server's executors patch the real entity instead of guessing by name. Absent on
   * create steps.
   */
  targetId?: string;
}

export interface StepPlan {
  steps: ProposedStep[];
}

/**
 * One non-table step's pre-generated tool-call payload (ADR-0048), produced by the
 * step-generation stage. `index` is the position of the step it belongs to in
 * `stepPlan.steps`.
 */
export interface GeneratedStep {
  index: number;
  type: StepType;
  payload: Record<string, unknown>;
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
  /** The fork's Step-list contract (ADR-0001/ADR-0004), produced by the step-plan stage. */
  stepPlan?: StepPlan;
  /**
   * Rendered live-app component index the caller passed to /generate/steps ("Existing
   * components already in this app: ..."). Prompt context only — the caller renders it
   * from the same source the server's planner uses (ADR-0048).
   */
  componentIndex?: string;
  /**
   * Caller-supplied app inventory snapshot (ADR-0054): present only for modify_app
   * requests. Its presence switches the pipeline to modify mode — feature-planner and
   * per-entity are skipped (nothing new to design tables for unless the PRD adds them)
   * and the step-plan prompt plans against what already exists.
   */
  appInventory?: string;
  /** Payloads for the step plan's non-table steps, produced by the step-generation stage. */
  generatedSteps?: GeneratedStep[];
  evaluation?: EvaluationVerdict;
}

/**
 * Wire-facing token usage for one LLM call. Field names follow the engine's SSE/JSON
 * contract (v4-era names kept deliberately stable on the wire); the AI SDK 6 result
 * fields `inputTokens`/`outputTokens`/`totalTokens` are normalized into this shape by
 * `normalizeLlmUsage` (./usage.ts).
 */
export interface LlmCallUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Sink for per-LLM-call token usage; routes inject one per request and aggregate it. */
export interface UsageRecorder {
  record(usage: LlmCallUsage): void;
}

export interface StageContext {
  organizationId: string;
  /**
   * The per-request LLM provider config (ADR-0038), already resolved by the caller
   * (the server's proxy resolves org BYOK/env fallback before invoking the engine) and
   * threaded through to every stage. Stages resolve their model from this — never from
   * env vars directly.
   */
  llm: EffectiveLlmConfig;
  /**
   * Aborted when the HTTP client disconnects (routes wire the hijacked response's
   * `close` event to it). Threaded into every LLM call as the SDK's `abortSignal` so an
   * aborted run stops generating instead of burning tokens nobody will read.
   */
  signal?: AbortSignal;
  /**
   * Records per-call token usage (AI SDK 6 task 2a). Optional so stage-level tests can
   * build a context without one; production routes always inject a recorder and surface
   * the cumulative total in their response/terminal SSE event.
   */
  usage?: UsageRecorder;
}

export interface PipelineStage {
  name: string;
  run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts>;
}
