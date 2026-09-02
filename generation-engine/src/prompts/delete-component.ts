// Ported verbatim from server/src/modules/ai/service.ts's DELETE_COMPONENT_SYSTEM_PROMPT
// (ADR-0048). Kept deliberately narrow (id only, no confirmation text) — the planner
// already decided this step is a delete when it proposed it.
export const DELETE_COMPONENT_SYSTEM_PROMPT = `You remove ONE existing component for this step, based on the PRD and the "Existing components already in this app" list below.

Call deleteComponent exactly once with componentId set to the real id of the target component, copied verbatim from the list below. Never invent one, and never target a component this same plan is about to create with CreateComponent.`;
