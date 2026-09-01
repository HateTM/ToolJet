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
      // (`create_table`, see agents.service.ts) — 'update' has no fork precedent yet,
      // see the TODO below.
      toolName: action === 'create' ? 'create_table' : 'update_table',
    };
  });
}

export interface PerEntityStageDeps {
  existing?: ReadonlySet<string>;
  /** Executes one routed tool-call against the LLM/tool-calling loop. */
  executeToolCall?(call: EntityToolCall, artifacts: PipelineArtifacts, ctx: StageContext): Promise<void>;
}

/**
 * Per-entity generation stage (ADR-0028's fifth stage). Ticket #93's known gap #4:
 * only `create-*` prompts exist in the fork today (ported verbatim); no `update-*`
 * per-entity prompt exists, and no ticket yet defines the update shape. This stage's
 * `create` routing is therefore real and testable; `update_table` is a placeholder
 * `toolName` with no backing prompt or TooljetDB action — routed correctly, not yet
 * executable.
 *
 * TODO(#93): once an update-* prompt/tool exists, wire it in via `deps.executeToolCall`.
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
