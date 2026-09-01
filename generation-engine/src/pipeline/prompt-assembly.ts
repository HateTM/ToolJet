import { toPromptContext } from '../catalogs';
import { EntityToolCall, FeaturePlan, PipelineArtifacts } from './types';

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
