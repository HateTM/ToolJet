import { z } from 'zod';
import { StepType } from './types';

/**
 * Zod schemas for the production LLM half's structured outputs (AI SDK 6 task 2a).
 * Each JSON-parsing stage gets a model-facing schema passed to the SDK's
 * `Output.object`, replacing the old "ask for JSON in prose + `JSON.parse` and hope"
 * contract: malformed model output now fails validation loudly (as a
 * `NoObjectGeneratedError` the route layer classifies), instead of being parsed
 * silently or leaking a SyntaxError.
 *
 * Deliberate leniency policy: these schemas are *loose* (`z.looseObject`, optional
 * fields) because each stage keeps its own deterministic, fail-closed validation
 * half downstream (parseClassification/parseLldSchema/parseStepPlan/
 * parseEvaluationVerdict — ADR-0034's deterministic/LLM split). The schemas exist to
 * guarantee well-formed JSON with the right top-level shape, not to duplicate or
 * tighten those stage contracts. Loose objects also *preserve* unknown keys — e.g. a
 * model that wrongly emits seed data on an LLD table must still reach
 * validateLldSchema's seed-key guard, not be silently stripped by the schema.
 */

export const classifyOutputSchema = z.looseObject({
  intent: z.string(),
  confidence: z.number().optional(),
});

export const lldOutputSchema = z.looseObject({
  tables: z.array(
    z.looseObject({
      table_name: z.string(),
      columns: z.array(
        z.looseObject({
          column_name: z.string(),
          data_type: z.string(),
          constraints_type: z
            .looseObject({
              is_primary_key: z.boolean().optional(),
              is_not_null: z.boolean().optional(),
              is_unique: z.boolean().optional(),
            })
            .optional(),
          column_default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        })
      ),
      foreign_keys: z
        .array(
          z.looseObject({
            column_name: z.string(),
            references_table: z.string(),
            references_column: z.string(),
          })
        )
        .optional(),
    })
  ),
});

export const stepPlanOutputSchema = z.looseObject({
  steps: z.array(
    z.looseObject({
      type: z.string(),
      description: z.string(),
      table: z
        .looseObject({
          table_name: z.string(),
          columns: z.array(z.looseObject({ column_name: z.string(), data_type: z.string() })),
        })
        .optional(),
      seed_rows: z.array(z.record(z.string(), z.unknown())).optional(),
      phase: z.string().optional(),
    })
  ),
});

export const evaluationOutputSchema = z.looseObject({
  pass: z.boolean(),
  reasons: z.array(z.string()).optional(),
});

/**
 * One payload schema per non-table step type (ADR-0048), keyed like
 * STEP_PAYLOAD_SYSTEM_PROMPTS. Only the keys the ported system prompts explicitly name
 * are modeled, and everything is loose: the payload contract itself stays
 * `Record<string, unknown>` (the fork's tool-call handlers own the deep shape); the
 * schema's job is JSON-mode grounding plus the few identifiers the prompts call
 * mandatory (a componentId/queryName the step cannot work without).
 */
export const STEP_PAYLOAD_OUTPUT_SCHEMAS: Record<Exclude<StepType, 'CreateTable' | 'UpdateTable'>, z.ZodType> = {
  CreateComponent: z.looseObject({}),
  UpdateComponent: z.looseObject({
    componentId: z.string(),
    properties: z.record(z.string(), z.unknown()).optional(),
    styles: z.record(z.string(), z.unknown()).optional(),
  }),
  DeleteComponent: z.looseObject({ componentId: z.string() }),
  MoveComponent: z.looseObject({
    componentId: z.string(),
    newParentComponentId: z.string().optional(),
  }),
  CreateQuery: z.looseObject({
    name: z.string().optional(),
    source: z.string().optional(),
  }),
  UpdateQuery: z.looseObject({ name: z.string().optional() }),
  DeleteQuery: z.looseObject({ queryName: z.string() }),
  GenerateEvent: z.looseObject({
    targetName: z.string().optional(),
    eventId: z.string().optional(),
    actionId: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    componentId: z.string().optional(),
    componentSpecificActionParams: z.array(z.unknown()).optional(),
  }),
};
