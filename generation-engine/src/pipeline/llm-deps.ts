import { generateText, Output } from 'ai';
import type { z } from 'zod';
import { resolveLanguageModel } from '../config/provider';
import {
  CLASSIFY_SYSTEM_PROMPT,
  CREATE_COMPONENT_SYSTEM_PROMPT,
  CREATE_QUERY_SYSTEM_PROMPT,
  CREATE_TABLE_SYSTEM_PROMPT,
  DELETE_COMPONENT_SYSTEM_PROMPT,
  DELETE_QUERY_SYSTEM_PROMPT,
  EVALUATE_SYSTEM_PROMPT,
  GENERATE_EVENT_SYSTEM_PROMPT,
  LLD_SYSTEM_PROMPT,
  MOVE_COMPONENT_SYSTEM_PROMPT,
  PRD_SYSTEM_PROMPT,
  STEP_PLAN_SYSTEM_PROMPT,
  UPDATE_COMPONENT_SYSTEM_PROMPT,
  UPDATE_QUERY_SYSTEM_PROMPT,
  UPDATE_TABLE_SYSTEM_PROMPT,
} from '../prompts';
import {
  buildEvaluateStageInput,
  buildLldStageInput,
  buildPerEntityStageInput,
  buildStepGenerationStageInput,
} from './prompt-assembly';
import {
  classifyOutputSchema,
  evaluationOutputSchema,
  lldOutputSchema,
  stepPlanOutputSchema,
  STEP_PAYLOAD_OUTPUT_SCHEMAS,
} from './schemas';
import { normalizeLlmUsage } from './usage';
import type { DefaultPipelineDeps } from './index';
import { StageContext, StepType } from './types';

/**
 * The real (production) LLM-calling halves of the pipeline's stages, wired per ticket
 * #110 from the prompt library (#93), the catalogs (#92) and the per-request
 * `EffectiveLlmConfig` (#94, ADR-0038). Every call resolves its model from
 * `ctx.llm` via `resolveLanguageModel` — no stage reads env vars directly; the caller
 * (the server-side proxy) resolves the org's config before the engine is invoked.
 *
 * AI SDK 6 (task 2a) changes to every call:
 *  - JSON-returning stages use structured outputs (`generateText` + `Output.object`
 *    with a zod schema from ./schemas.ts) instead of prose-JSON + manual `JSON.parse`.
 *    `generateObject` itself is deprecated in AI SDK 6 (migration guide 6-0), so the
 *    `output` setting on `generateText` is the supported spelling of the same thing.
 *  - `ctx.signal` is passed as `abortSignal` so a client disconnect stops generation.
 *  - `experimental_telemetry` is enabled as a passthrough: spans go through
 *    `@opentelemetry/api`'s global tracer, which `ai` already depends on — no OTel SDK
 *    dependency is added, and without a host-registered TracerProvider it stays a
 *    no-op. Inputs/outputs are not recorded (prompts may carry user data).
 *  - per-call token usage is recorded into `ctx.usage` (./usage.ts normalizes the
 *    SDK's `inputTokens`/`outputTokens` to the wire's `promptTokens`/
 *    `completionTokens`).
 *
 * All calls are plain non-streaming completions: streaming to the browser is the server
 * proxy's concern (ADR-0027), and #91's SSE route stays the streaming PRD path — see
 * the note in ADR-0028.
 */

/**
 * Telemetry settings shared by every LLM call (see module doc for why passthrough-only,
 * and why this is not a hard OTel dependency).
 */
const TELEMETRY_SETTINGS = {
  isEnabled: true,
  recordInputs: false,
  recordOutputs: false,
} as const;

/**
 * One non-streaming LLM completion: system + user message, plain-text response. When a
 * `schema` is given the call runs in structured-output mode and `output` carries the
 * validated object; otherwise only `text` is meaningful.
 */
async function callModel(
  system: string,
  user: string,
  ctx: StageContext,
  schema?: z.ZodType
): Promise<{ text: string; output?: unknown }> {
  const result = await generateText({
    model: resolveLanguageModel(ctx.llm),
    // AI SDK 6 rejects `system`-role entries inside `messages` — must go through
    // `instructions` instead (see generate-prd.ts's defaultStreamPrd for the fuller note).
    instructions: system,
    messages: [{ role: 'user', content: user }],
    abortSignal: ctx.signal,
    experimental_telemetry: TELEMETRY_SETTINGS,
    ...(schema ? { output: Output.object({ schema }) } : {}),
  });
  ctx.usage?.record(normalizeLlmUsage(result.usage));
  return { text: result.text, output: schema ? result.output : undefined };
}

/** Plain-text completion (PRD stage). */
async function complete(system: string, user: string, ctx: StageContext): Promise<string> {
  const { text } = await callModel(system, user, ctx);
  return text;
}

/**
 * A completion whose output must be a JSON payload conforming to `schema`. The SDK
 * validates against the schema (structured-output mode), so a malformed response
 * surfaces as a typed `NoObjectGeneratedError` the route layer classifies — it is no
 * longer possible for a non-JSON payload to slip through as a silently-parsed
 * contract. Stage-level deterministic validators downstream keep final say on content.
 */
async function completeObject(
  system: string,
  user: string,
  ctx: StageContext,
  schema: z.ZodType
): Promise<unknown> {
  const { output } = await callModel(system, user, ctx, schema);
  return output;
}

/**
 * Step type -> ported system prompt (ADR-0048). All eight non-table types have entries:
 * the five ADR-0048 ports plus the three already in the #93 library. CreateTable and
 * UpdateTable are absent — per-entity owns table payloads (ADR-0028, ADR-0041).
 */
const STEP_PAYLOAD_SYSTEM_PROMPTS: Record<Exclude<StepType, 'CreateTable' | 'UpdateTable'>, string> = {
  CreateComponent: CREATE_COMPONENT_SYSTEM_PROMPT,
  UpdateComponent: UPDATE_COMPONENT_SYSTEM_PROMPT,
  DeleteComponent: DELETE_COMPONENT_SYSTEM_PROMPT,
  MoveComponent: MOVE_COMPONENT_SYSTEM_PROMPT,
  CreateQuery: CREATE_QUERY_SYSTEM_PROMPT,
  UpdateQuery: UPDATE_QUERY_SYSTEM_PROMPT,
  DeleteQuery: DELETE_QUERY_SYSTEM_PROMPT,
  GenerateEvent: GENERATE_EVENT_SYSTEM_PROMPT,
};

/**
 * Production `DefaultPipelineDeps`. The feature-planner keeps its deterministic default
 * (no `planFeatures` refinement — ADR-0040 keeps it engine-internal and 1:1 per table),
 * and per-entity dispatch routes deterministically; `executeToolCall` generates the
 * per-entity prompt for each routed call using the create/update prompts and the catalog
 * context. The actual TooljetDB-side execution of `update_table` lives on the server
 * (#111), not in the engine.
 */
export function buildRealPipelineDeps(): DefaultPipelineDeps {
  return {
    classify: {
      async classify(prompt, ctx) {
        return completeObject(CLASSIFY_SYSTEM_PROMPT, prompt, ctx, classifyOutputSchema);
      },
    },
    prd: {
      // Plain (non-streaming) call on purpose: the engine's pipeline runs PRD as one
      // stage among seven for internal/batch callers; browser streaming goes through
      // #91's POST /generate/prd SSE route instead (ADR-0027/ADR-0028 note).
      async generatePrd(input, ctx) {
        return complete(PRD_SYSTEM_PROMPT, input, ctx);
      },
    },
    lld: {
      async generateLld(prd, ctx) {
        return completeObject(LLD_SYSTEM_PROMPT, buildLldStageInput(prd), ctx, lldOutputSchema);
      },
    },
    perEntity: {
      async executeToolCall(call, artifacts, ctx) {
        const system = call.action === 'update' ? UPDATE_TABLE_SYSTEM_PROMPT : CREATE_TABLE_SYSTEM_PROMPT;
        await complete(system, buildPerEntityStageInput(call, artifacts), ctx);
      },
    },
    stepPlan: {
      async generateStepPlan(input, ctx) {
        return completeObject(STEP_PLAN_SYSTEM_PROMPT, input, ctx, stepPlanOutputSchema);
      },
    },
    stepGeneration: {
      async generateStepPayload(step, index, artifacts, ctx) {
        const system = STEP_PAYLOAD_SYSTEM_PROMPTS[step.type as Exclude<StepType, 'CreateTable' | 'UpdateTable'>];
        if (!system) {
          throw new Error(`step-generation has no system prompt for step type "${step.type}"`);
        }
        const schema = STEP_PAYLOAD_OUTPUT_SCHEMAS[step.type as Exclude<StepType, 'CreateTable' | 'UpdateTable'>];
        if (!schema) {
          throw new Error(`step-generation has no payload schema for step type "${step.type}"`);
        }
        return completeObject(system, buildStepGenerationStageInput(step, index, artifacts), ctx, schema);
      },
    },
    evaluate: {
      async judge(artifacts, ctx) {
        return completeObject(EVALUATE_SYSTEM_PROMPT, buildEvaluateStageInput(artifacts), ctx, evaluationOutputSchema);
      },
    },
  };
}
