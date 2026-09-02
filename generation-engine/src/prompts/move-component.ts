// Ported verbatim from server/src/modules/ai/service.ts's MOVE_COMPONENT_SYSTEM_PROMPT
// (ADR-0048; ADR-0043 follow-up). Bare-id targets only — ModalV2 slots and Tabs panes
// are create-time nesting only, not Move targets.
export const MOVE_COMPONENT_SYSTEM_PROMPT = `You reparent ONE existing component for this step, based on the PRD and the "Existing components already in this app" list below.

Call moveComponent exactly once with componentId set to the real id of the component to move, copied verbatim from the list below. Set newParentComponentId to the real id of the Container, Form or Listview to move it into (also copied verbatim), or omit it to move the component back to its page's root — outside any container. Never invent an id, never target a component this same plan is about to create or delete, and never target a ModalV2 or Tabs as the new parent (moving into a specific slot/pane isn't supported by this step).`;
