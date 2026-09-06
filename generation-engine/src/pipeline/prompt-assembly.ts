import { toPromptContext } from '../catalogs';
import { EntityToolCall, FeaturePlan, PipelineArtifacts, ProposedStep, StepType } from './types';

/**
 * Deterministic prompt assembly for the stages that ground their generation against the
 * component/event catalogs (ADR-0033, wired per ticket #110). Kept separate from the
 * LLM-calling deps (`./llm-deps.ts`) so the assembled inputs are unit-testable without
 * an LLM, per ADR-0034's deterministic/LLM split.
 */

/** Compact JSON rendering of both catalogs for injection into a prompt. */
export function buildCatalogPromptContext(): string {
  return JSON.stringify(toPromptContext(), null, 2);
}

/**
 * The LLD stage's user message: the PRD plus the catalog context, so the model designs
 * schemas that stay renderable/wireable by the fork's real widget and event vocabulary
 * instead of inventing types the platform doesn't have.
 */
export function buildLldStageInput(prd: string): string {
  return [
    '# PRD',
    '',
    prd,
    '',
    '# Component and event catalogs',
    '',
    'The app built from this schema will use exactly these components and event actions (JSON). Design tables/columns that can back them — no invented platform concepts:',
    '',
    buildCatalogPromptContext(),
  ].join('\n');
}

/**
 * The per-entity stage's user message for one routed tool-call: the PRD, the entity and
 * its create/update routing (ADR-0041's full-replace shape for updates), its dependency
 * ordering, and the catalog context (per-entity generation must know which widgets and
 * events the generated table will be wired to).
 */
export function buildPerEntityStageInput(call: EntityToolCall, artifacts: PipelineArtifacts): string {
  const sections: string[] = [
    '# PRD',
    '',
    artifacts.prd ?? '',
    '',
    `# Entity to ${call.action}`,
    '',
    `Entity: ${call.entityName}`,
    `Tool call: ${call.toolName}`,
  ];

  if (artifacts.featurePlan) {
    const item = artifacts.featurePlan.items.find((i) => i.entityName === call.entityName);
    if (item) {
      sections.push(
        '',
        '# Dependencies',
        '',
        item.dependsOn.length > 0
          ? `Depends on already-generated entities: ${item.dependsOn.join(', ')}`
          : 'Depends on no other entity.'
      );
    }
  }

  sections.push(
    '',
    '# Component and event catalogs',
    '',
    'This entity will be wired to these components and event actions (JSON):',
    '',
    buildCatalogPromptContext()
  );

  return sections.join('\n');
}

/**
 * The evaluate stage's judge input: a compact summary of what was generated (PRD text,
 * entity tool-calls, the proposed step plan) — not the full artifact bag, so the judge
 * sees what a reviewer would see.
 */
export function buildEvaluateStageInput(artifacts: PipelineArtifacts): string {
  return JSON.stringify(
    {
      prd: artifacts.prd,
      entityToolCalls: artifacts.entityToolCalls,
      featurePlan: artifacts.featurePlan,
      stepPlan: artifacts.stepPlan,
    },
    null,
    2
  );
}

/** The feature-plan ordering hint a stage may include (see step-plan.ts's input builder). */
export function featurePlanOrdering(featurePlan: FeaturePlan): string {
  return featurePlan.items.map((item) => item.entityName).join(' -> ');
}

/**
 * The forced tool-call name each non-table StepType's payload rides (ADR-0048) — mirrors
 * the tool names in server/src/modules/ai/service.ts. CreateTable is absent: table
 * payloads are per-entity's concern (ADR-0028).
 */
export const STEP_PAYLOAD_TOOL_NAMES: Partial<Record<StepType, string>> = {
  CreateComponent: 'createComponent',
  UpdateComponent: 'updateComponent',
  DeleteComponent: 'deleteComponent',
  MoveComponent: 'moveComponent',
  CreateQuery: 'createQuery',
  UpdateQuery: 'updateQuery',
  DeleteQuery: 'deleteQuery',
  GenerateEvent: 'generateEvent',
};

/**
 * The step-generation stage's user message for one step (ADR-0048): the PRD, the
 * caller-supplied component index verbatim (it arrives self-headed "Existing components
 * already in this app: ..."), the plan's earlier steps, and the JSON response contract.
 * The system prompt is ported verbatim from the server and keeps its forced tool-call
 * wording; the engine realizes that contract as plain JSON (no tool plumbing), so the
 * response-format instruction closes the gap. GenerateEvent steps additionally get the
 * machine catalogs — same grounding the server's executeEventStep appends (ticket #67).
 */
export function buildStepGenerationStageInput(
  step: ProposedStep,
  index: number,
  artifacts: PipelineArtifacts
): string {
  const toolName = STEP_PAYLOAD_TOOL_NAMES[step.type];
  if (!toolName) {
    throw new Error(`buildStepGenerationStageInput has no payload contract for step type "${step.type}"`);
  }
  const sections: string[] = ['# PRD', '', artifacts.prd ?? ''];

  if (artifacts.componentIndex) {
    sections.push('', artifacts.componentIndex);
  }

  // Strictly the steps before this one: a payload must only reference things the plan
  // has already produced by this point, never steps that come later (code-review P2).
  const earlier = (artifacts.stepPlan?.steps ?? [])
    .slice(0, index)
    .map((s, i) => `${i}. ${s.type}: ${s.description}`)
    .join('\n');

  sections.push(
    '',
    '# The step to generate',
    '',
    JSON.stringify(
      {
        index,
        type: step.type,
        description: step.description,
        // Modify mode (ADR-0054): the existing component/query id this step targets —
        // the payload must reference it, not a name it would have to guess.
        ...(step.targetId && { targetId: step.targetId }),
      },
      null,
      2
    ),
    '',
    '# Earlier steps in this plan (order)',
    '',
    earlier || '(none)'
  );

  if (step.type === 'GenerateEvent') {
    sections.push(
      '',
      '# Component and event catalogs',
      '',
      'Pick eventIds, actionIds and their keys ONLY from this catalog (JSON):',
      '',
      buildCatalogPromptContext()
    );
  }

  sections.push(
    '',
    `Respond with a single JSON object and nothing else — the argument payload of the ${toolName} tool call described in the system prompt. No prose, no markdown fences.`
  );

  return sections.join('\n');
}
