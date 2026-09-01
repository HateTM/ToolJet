import { generateText } from 'ai';
import { resolveLanguageModel } from '../config/provider';
import {
  CLASSIFY_SYSTEM_PROMPT,
  CREATE_TABLE_SYSTEM_PROMPT,
  EVALUATE_SYSTEM_PROMPT,
  LLD_SYSTEM_PROMPT,
  PRD_SYSTEM_PROMPT,
  STEP_PLAN_SYSTEM_PROMPT,
  UPDATE_TABLE_SYSTEM_PROMPT,
} from '../prompts';
import { buildEvaluateStageInput, buildLldStageInput, buildPerEntityStageInput } from './prompt-assembly';
import type { DefaultPipelineDeps } from './index';
import { StageContext } from './types';

/**
 * The real (production) LLM-calling halves of the pipeline's stages, wired per ticket
 * #110 from the prompt library (#93), the catalogs (#92) and the per-request
 * `EffectiveLlmConfig` (#94, ADR-0038). Every call resolves its model from
 * `ctx.llm` via `resolveLanguageModel` — no stage reads env vars directly; the caller
 * (the server-side proxy) resolves the org's config before the engine is invoked.
 *
 * All calls are plain non-streaming `generateText` completions: streaming to the browser
 * is the server proxy's concern (ADR-0027), and #91's SSE route stays the streaming PRD
 * path — see the note in ADR-0028.
 */

/** One non-streaming LLM completion: system + user message, plain-text response. */
async function complete(system: string, user: string, ctx: StageContext): Promise<string> {
  const result = await generateText({
    model: resolveLanguageModel(ctx.llm),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return result.text;
}

/**
 * A completion whose output must be a JSON payload (classify/lld/step-plan/evaluate all
 * parse their raw response downstream). A non-JSON response is surfaced as a plain
 * Error so the orchestrator wraps it in a `PipelineStageError` naming the stage, instead
 * of leaking a SyntaxError from deep inside.
 */
async function completeJson(system: string, user: string, ctx: StageContext): Promise<unknown> {
  const text = await complete(system, user, ctx);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('LLM returned a non-JSON payload');
  }
}

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
        return completeJson(CLASSIFY_SYSTEM_PROMPT, prompt, ctx);
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
        return completeJson(LLD_SYSTEM_PROMPT, buildLldStageInput(prd), ctx);
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
        return completeJson(STEP_PLAN_SYSTEM_PROMPT, input, ctx);
      },
    },
    evaluate: {
      async judge(artifacts, ctx) {
        return completeJson(EVALUATE_SYSTEM_PROMPT, buildEvaluateStageInput(artifacts), ctx);
      },
    },
  };
}
