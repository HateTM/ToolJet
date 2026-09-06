import {
  PlannedTableDefinition,
  PipelineArtifacts,
  PipelineStage,
  ProposedStep,
  StageContext,
  StepPlan,
  StepType,
  STEP_TYPES,
} from './types';

/**
 * Thrown when a raw (LLM-produced) step-plan payload fails validation — the same policy
 * as the fork's "The assistant did not propose a build plan" throw in
 * `server/src/modules/ai/service.ts`: a missing or malformed plan is a hard error, never
 * an empty plan silently persisted.
 */
export class StepPlanValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Step plan invalid: ${issues.join('; ')}`);
    this.name = 'StepPlanValidationError';
    this.issues = issues;
  }
}

/**
 * Assembles the model input for the step-plan stage (ADR-0040): the PRD plus the LLD's
 * proposed tables and the FeaturePlan's dependency ordering as a hint. Pure/
 * deterministic on purpose so it's testable without an LLM. The FeaturePlan section is a
 * hint, not a command — the planner (like the fork's own prompt, ADR-0021) stays free to
 * interleave non-table steps.
 */
export function buildStepPlanStageInput(artifacts: PipelineArtifacts): string {
  const sections: string[] = [`# PRD\n\n${artifacts.prd ?? ''}`];

  if (artifacts.lld) {
    const tables = artifacts.lld.tables
      .map((table) => `${table.table_name}(${table.columns.map((c) => c.column_name).join(', ')})`)
      .join('; ');
    sections.push(`# LLD schema — proposed tables\n\n${tables}`);
  }

  if (artifacts.featurePlan) {
    const order = artifacts.featurePlan.items.map((item) => item.entityName).join(' -> ');
    sections.push(`# Feature-plan ordering — build tables in this dependency order\n\n${order}`);
  }

  // Modify mode (ADR-0054): the caller supplied an app inventory snapshot, so the plan
  // must amend the existing app rather than rebuild it. The sparse-patch contract for
  // component/query updates mirrors what the server's executors validate
  // (sanitizeComponentSection / UpdateQuery's changed-keys-only shape).
  if (artifacts.appInventory) {
    sections.push(
      `# Modifying an existing app\n\n` +
        `This request modifies an app that already exists. The current app inventory follows this instruction, and the component index describes the existing UI. Plan amendments, not a rebuild:\n\n` +
        `- Target existing components and queries by their exact id from the inventory: set the step's targetId to that id and use UpdateComponent, UpdateQuery, DeleteComponent, DeleteQuery or MoveComponent.\n` +
        `- For UpdateComponent, the generated payload must contain ONLY the changed keys (properties/styles entries), with each changed value wrapped as { value: ... }. Never repeat unchanged properties.\n` +
        `- For UpdateQuery, return only the option keys that change; nothing else on the query is touched.\n` +
        `- Use Delete*/MoveComponent steps only for what the PRD explicitly asks to remove or reposition.\n` +
        `- Use CreateTable, CreateQuery or CreateComponent ONLY for things that do not exist yet, and never recreate something the inventory already has.\n\n` +
        `# App inventory (current state of the app)\n\n${artifacts.appInventory}`
    );
  }

  return sections.join('\n\n');
}

/**
 * Fork-parity well-formedness for a planner-proposed table: the same minimal check as
 * `isWellFormedTableDefinition` in `server/src/modules/ai/service.ts` — a non-empty
 * table_name and at least one column with a non-empty column_name. Deeper shape
 * correctness stays the fork's contract concern, not the engine's.
 */
function isWellFormedPlannedTable(table: unknown): table is PlannedTableDefinition {
  if (typeof table !== 'object' || table === null) return false;
  const candidate = table as { table_name?: unknown; columns?: unknown };
  return (
    typeof candidate.table_name === 'string' &&
    candidate.table_name.trim().length > 0 &&
    Array.isArray(candidate.columns) &&
    candidate.columns.length > 0 &&
    candidate.columns.every(
      (column) =>
        typeof column === 'object' &&
        column !== null &&
        typeof (column as { column_name?: unknown }).column_name === 'string' &&
        ((column as { column_name?: unknown }).column_name as string).trim().length > 0
    )
  );
}

/**
 * Parses and validates a raw (LLM-produced) step-plan payload into the fork's Step-list
 * contract shape. Policy mirrors the fork's plan-time handling in `service.ts` exactly:
 *
 * - a payload that isn't a `{ steps: [...] }` object, or an empty step list, is a hard
 *   validation error (the fork throws "The assistant did not propose a build plan");
 * - an unknown StepType or an empty/missing description is a hard validation error (no
 *   handler exists for anything outside the v1 vocabulary, ADR-0002/0006);
 * - a malformed planned table or seed-row list on an otherwise valid step is *dropped*,
 *   not fatal — execution falls back to the per-step LLM path rather than trusting a
 *   half-formed contract (the `isWellFormedTableDefinition`/seed-rows policy);
 * - a non-string phase is a hard error: the client groups steps by it verbatim
 *   (ADR-0021), so a wrong-typed label must not ride through.
 */
export function parseStepPlan(raw: unknown): StepPlan {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { steps?: unknown }).steps)) {
    throw new StepPlanValidationError(['payload is not a { steps: [...] } object']);
  }

  const issues: string[] = [];
  const proposed = raw as { steps: unknown[] };
  if (proposed.steps.length === 0) {
    issues.push('plan has no steps');
  }

  const steps: ProposedStep[] = [];

  proposed.steps.forEach((step, index) => {
    if (typeof step !== 'object' || step === null) {
      issues.push(`step ${index} is not an object`);
      return;
    }

    const candidate = step as {
      type?: unknown;
      description?: unknown;
      table?: unknown;
      seed_rows?: unknown;
      phase?: unknown;
      targetId?: unknown;
    };

    if (!STEP_TYPES.includes(candidate.type as StepType)) {
      issues.push(`step ${index} has unknown type "${String(candidate.type)}"`);
    }
    if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) {
      issues.push(`step ${index} has an empty or missing description`);
    }
    if (candidate.phase !== undefined && typeof candidate.phase !== 'string') {
      issues.push(`step ${index} has a non-string phase`);
    }

    steps.push({
      type: candidate.type as StepType,
      description: typeof candidate.description === 'string' ? candidate.description : '',
      // Fork policy: drop malformed planned table/seed rows, keep the step itself.
      table: isWellFormedPlannedTable(candidate.table) ? candidate.table : undefined,
      seed_rows: Array.isArray(candidate.seed_rows) ? (candidate.seed_rows as ProposedStep['seed_rows']) : undefined,
      phase: typeof candidate.phase === 'string' ? candidate.phase : undefined,
      // Same drop-don't-fail policy as table/seed_rows: a non-string targetId on an
      // otherwise valid step is discarded (the step just loses its explicit target).
      targetId: typeof candidate.targetId === 'string' && candidate.targetId.trim().length > 0 ? candidate.targetId : undefined,
    });
  });

  if (issues.length > 0) {
    throw new StepPlanValidationError(issues);
  }

  return { steps };
}

export interface StepPlanStageDeps {
  /** Calls the LLM (tool-forced `proposeStepPlan` in production) and returns its raw payload. */
  generateStepPlan(input: string, ctx: StageContext): Promise<unknown>;
}

/**
 * Step-plan stage — the terminal planning stage of the pipeline (ADR-0040, settling
 * #112): it converts PRD + LLD (+ FeaturePlan ordering) into the fork's Step-list
 * contract (ADR-0001/ADR-0004, shape unchanged), closing the loop to what the server's
 * `approvePrd` flow consumes today. It does NOT subsume or wrap feature-planner — that
 * stage stays engine-internal (table ordering for per-entity generation); see ADR-0040
 * for why they are two stages.
 *
 * Wired per ticket #110: the production `deps.generateStepPlan` (./llm-deps.ts) calls
 * the ported step-plan prompt (`prompts/step-plan.ts`, #93) on `ctx.llm` and parses the
 * raw payload with `parseStepPlan` below.
 */
export function buildStepPlanStage(deps: StepPlanStageDeps): PipelineStage {
  return {
    name: 'step-plan',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      if (!artifacts.prd) {
        throw new Error('step-plan stage requires artifacts.prd (PRD stage must run first)');
      }
      if (!artifacts.lld) {
        throw new Error('step-plan stage requires artifacts.lld (LLD stage must run first)');
      }

      const raw = await deps.generateStepPlan(buildStepPlanStageInput(artifacts), ctx);
      return { ...artifacts, stepPlan: parseStepPlan(raw) };
    },
  };
}
