// Placeholder — ticket #93 (docs/adr/0030). The fork's own classify() stub
// (server/src/modules/ai/services/agents.service.ts) has never had real prompt content —
// it throws "Method not implemented." — so there is no existing behavior to port here.
// This stands in for issue #82's classification pipeline stage (the first stage, ahead
// of PRD) until the ticket that implements it fills in real content.
// TODO (#82): replace with the real classification system prompt.
export const CLASSIFY_SYSTEM_PROMPT = `TODO (#82): classification stage system prompt — not yet implemented.`;
