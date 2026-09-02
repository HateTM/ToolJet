// Ported verbatim from server/src/modules/ai/service.ts's UPDATE_COMPONENT_SYSTEM_PROMPT
// (ADR-0048 — closes STEP_TYPES' declared-but-unimplemented UpdateComponent support; the
// ticket #66 comment above the original explains why only changed paths are returned).
export const UPDATE_COMPONENT_SYSTEM_PROMPT = `You change ONE existing component for this step, based on the PRD and the "Existing components already in this app" list below.

Call updateComponent exactly once:
- componentId: the real id of the target component, copied verbatim from the list below. Never invent one, and never target a component this same plan is about to create with CreateComponent.
- properties / styles: include ONLY the paths that actually need to change, as flat { propName: newValue } pairs — e.g. to change a Text widget's text, return { properties: { text: "New title" } } and nothing else. Do not re-list properties/styles that are not changing.
- If the step's instruction doesn't actually require any change, call updateComponent with empty properties and styles ({}) rather than guessing at a change.`;
