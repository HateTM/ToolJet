import { GeneratedStep, PipelineArtifacts, PipelineStage, ProposedStep, StageContext } from './types';
import { STEP_PAYLOAD_TOOL_NAMES } from './prompt-assembly';

export interface StepGenerationStageDeps {
  /**
   * Calls the LLM for one non-table step and returns its raw payload. The production
   * half (./llm-deps.ts) dispatches the step type onto its ported system prompt
   * (prompts/index.ts) and parses the response as JSON.
   */
  generateStepPayload(
    step: ProposedStep,
    index: number,
    artifacts: PipelineArtifacts,
    ctx: StageContext
  ): Promise<unknown>;
}

/**
 * Step-generation stage (ADR-0048) — closes the engine's parity debt: STEP_TYPES
 * declares ten step types, but before this stage only tables had a payload path
 * (per-entity). Runs after step-plan: takes every non-table step of the plan (both
 * CreateTable and UpdateTable stay per-entity's concern, ADR-0028/ADR-0041),
 * generates its tool-call payload through deps.generateStepPayload, and stores the
 * result on `artifacts.generatedSteps`, keyed by the step's index in the plan.
 *
 * Policy mirrors step-plan's: a non-object payload is a hard error, never a silently
 * dropped contract — the server's fallback decides what to do with failures (ADR-0048
 * decision 5), the stage itself fails loudly.
 */
export function buildStepGenerationStage(deps: StepGenerationStageDeps): PipelineStage {
  return {
    name: 'step-generation',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      if (!artifacts.stepPlan) {
        throw new Error('step-generation stage requires artifacts.stepPlan (step-plan stage must run first)');
      }

      const generatedSteps: GeneratedStep[] = [];
      for (let index = 0; index < artifacts.stepPlan.steps.length; index++) {
        const step = artifacts.stepPlan.steps[index];
        if (step.type === 'CreateTable' || step.type === 'UpdateTable') {
          continue; // table payloads are per-entity's concern (ADR-0028, ADR-0041)
        }
        if (!STEP_PAYLOAD_TOOL_NAMES[step.type]) {
          throw new Error(`step-generation has no payload contract for step type "${step.type}" (step ${index})`);
        }
        const raw = await deps.generateStepPayload(step, index, artifacts, ctx);
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new Error(
            `step-generation produced a non-object payload for step ${index} (${step.type})`
          );
        }
        generatedSteps.push({ index, type: step.type, payload: raw as Record<string, unknown> });
      }

      return { ...artifacts, generatedSteps };
    },
  };
}
