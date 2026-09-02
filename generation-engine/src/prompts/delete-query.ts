// Ported verbatim from server/src/modules/ai/service.ts's DELETE_QUERY_SYSTEM_PROMPT
// (ADR-0048). Mirrors UpdateQuery's scope on purpose (ADR-0027): only a query this same
// plan created earlier can be targeted, never an arbitrary pre-existing query.
export const DELETE_QUERY_SYSTEM_PROMPT = `You remove ONE existing query for this step, based on the PRD and the "Existing queries" list below.

Call deleteQuery exactly once with queryName set to the exact name of the target query, copied verbatim from the list below.`;
