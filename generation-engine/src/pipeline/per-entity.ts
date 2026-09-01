import { EntityToolCall, FeaturePlan, PipelineArtifacts, PipelineStage, StageContext } from './types';

/**
 * Routes each feature-plan item to a distinct create/update tool-call (AC #3: "Per-entity
 * generation dispatches distinct create/update tool-calls per entity type"). `existing`
 * is the set of entity names that already exist for this app/version — anything not in
 * it gets a `create` call, anything in it gets `update`. Pure/deterministic: the
 * create-vs-update decision is a set-membership check, not an LLM judgment.
 */
export function routeEntityToolCalls(plan: FeaturePlan, existing: ReadonlySet<string> = new Set()): EntityToolCall[] {
  return plan.items.map((item) => {
    const action = existing.has(item.entityName) ? 'update' : 'create';
    return {
      entityName: item.entityName,
      action,
      // Mirrors TooljetDbTableOperationsService's action-name convention
      // (`create_table`, see agents.service.ts). `update_table` carries a
      // full-replace payload (UpdateTableCallPayload, ADR-0041); the payload itself
      // is produced by the executor's LLM loop and validated by
      // validateUpdateTableCall below.
      toolName: action === 'create' ? 'create_table' : 'update_table',
    };
  });
}

/**
 * Deterministic validator for an `update_table` tool call's full-replace payload
 * (ADR-0041, per ADR-0034's "unit-test the deterministic scaffolding"). Returns the
 * list of problems — empty means valid. Checks what is checkable without the table's
 * current schema; the server-side executor re-validates against the real schema
 * (e.g. rename sources and destructive drops) when it diffs.
 */
export function validateUpdateTableCall(call: EntityToolCall): string[] {
  const problems: string[] = [];
  if (call.action !== 'update' || call.toolName !== 'update_table') return problems;

  const payload: UpdateTableCallPayload | undefined = call.payload;
  if (!payload) {
    problems.push(`update_table call for "${call.entityName}" is missing its payload`);
    return problems;
  }
  if (payload.table_name !== call.entityName) {
    problems.push(
      `update_table payload table_name "${payload.table_name}" does not match the routed entity "${call.entityName}"`
    );
  }
  if (!Array.isArray(payload.columns) || payload.columns.length === 0) {
    problems.push('update_table payload must carry a non-empty columns list');
    return problems;
  }

  const columnNames = new Set<string>();
  for (const column of payload.columns) {
    if (!column || typeof column.column_name !== 'string' || !column.column_name) {
      problems.push('update_table payload has a column without a column_name');
      continue;
    }
    if (columnNames.has(column.column_name)) {
      problems.push(`update_table payload lists column "${column.column_name}" more than once`);
    }
    columnNames.add(column.column_name);
    if (typeof column.data_type !== 'string' || !column.data_type) {
      problems.push(`column "${column.column_name}" has no data_type`);
    }
    if (typeof column.is_primary_key !== 'boolean') {
      problems.push(`column "${column.column_name}" has no boolean is_primary_key`);
    }
  }

  const primaryKeys = payload.columns.filter((column) => column?.is_primary_key === true);
  if (primaryKeys.length !== 1) {
    problems.push(`update_table payload must have exactly one primary key column, found ${primaryKeys.length}`);
  }

  for (const [from, to] of Object.entries(payload.renames ?? {})) {
    if (columnNames.has(from)) {
      problems.push(`rename source "${from}" is also in the desired columns list — a rename's old name must not be`);
    }
    if (!columnNames.has(to)) {
      problems.push(`rename target "${to}" is not a column in the desired columns list`);
    }
  }

  return problems;
}

export interface PerEntityStageDeps {
  existing?: ReadonlySet<string>;
  /** Executes one routed tool-call against the LLM/tool-calling loop. */
  executeToolCall?(call: EntityToolCall, artifacts: PipelineArtifacts, ctx: StageContext): Promise<void>;
}

/**
 * Per-entity generation stage (ADR-0028's fifth stage). The update shape is decided by
 * ADR-0041: an `update_table` tool call is a full-replace of the table's column
 * definition, validated deterministically by `validateUpdateTableCall`. The prompt
 * (generation-engine prompts/update-table.ts, #93 branch) and the TooljetDB-side
 * execution (#111 branch) land alongside this ADR.
 *
 * TODO(#92): entity generation is expected to consult the component/event catalogs
 * (ADR-0033) to know which widgets/events a generated table can be wired to — not
 * wired up here.
 */
export function buildPerEntityStage(deps: PerEntityStageDeps = {}): PipelineStage {
  return {
    name: 'per-entity',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      if (!artifacts.featurePlan) {
        throw new Error('per-entity stage requires artifacts.featurePlan (feature-planner stage must run first)');
      }

      const entityToolCalls = routeEntityToolCalls(artifacts.featurePlan, deps.existing);

      if (deps.executeToolCall) {
        for (const call of entityToolCalls) {
          await deps.executeToolCall(call, artifacts, ctx);
        }
      }

      return { ...artifacts, entityToolCalls };
    },
  };
}
