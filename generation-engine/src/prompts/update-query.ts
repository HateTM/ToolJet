// Ported verbatim from server/src/modules/ai/services/query-update.ts's
// UPDATE_QUERY_SYSTEM_PROMPT (ticket #93 — see docs/adr/0030; stub added by
// ticket #118). Per-entity generation prompt: updates one existing data query
// created by an earlier UpdateQuery step, returning only the changed option keys.
//
// TODO (#118): per-entity wiring (the updateQuery tool and step execution path) is
// out of scope for the prompt-library port — when that stage lands in the engine,
// consume this prompt instead of re-importing from server code.
export const UPDATE_QUERY_SYSTEM_PROMPT = `You update one existing data query in a ToolJet app, based on the PRD and the specific step you've been asked to build.

Call updateQuery exactly once. You are shown the query's current options and the list of other queries in the app; pick the target by its exact name.

Rules:
- Return ONLY the option keys that actually change, with their new values. Everything you omit is left exactly as it is — never return unchanged keys, and never return the whole options object.
- Never change the query's name or its data source. They are not part of the response.
- When the query runs against a connected SQL source (mode "sql"), the updated statement must remain a single read-only SELECT.
- Keep expression syntax consistent with the rest of the options: bindings use {{ components.name.property }} / {{ queries.name.data }}.`;
