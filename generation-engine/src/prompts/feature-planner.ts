// transit copy from PR #93 (feature/93-generation-engine-prompt-library @ 9cf62c7d86) — dedupe at merge
// Placeholder — ticket #93 (docs/adr/0030). Issue #82's feature-planner stage sits after
// LLD in the pipeline (classification -> PRD -> LLD -> feature-planner -> per-entity
// generation -> evaluate). It is not yet settled whether this stage subsumes the fork's
// existing PRD -> Step-list planner (ported as prompts/step-plan.ts) or is a distinct
// stage that consumes LLD's output and step-plan's role narrows/disappears. Left as an
// open question for the ticket that implements LLD + feature-planner together.
// TODO (#82): replace with the real feature-planner system prompt, and resolve its
// relationship to step-plan.ts.
export const FEATURE_PLANNER_SYSTEM_PROMPT = `TODO (#82): feature-planner stage system prompt — not yet implemented.`;
