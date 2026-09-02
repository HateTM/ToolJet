// Ported verbatim from server/src/modules/ai/service.ts's CREATE_QUERY_SYSTEM_PROMPT
// (ticket #93 — see docs/adr/0030). Per-entity generation prompt: creates one data
// query for a single CreateQuery step, against a ToolJet DB table this plan already
// created or against a data source the user has already connected.
export const CREATE_QUERY_SYSTEM_PROMPT = `You create one data query for this step, based on the PRD, the table(s) already created earlier in this plan, and the connected data sources listed below (if any).

Call createQuery exactly once with a short snake_case query name (components will reference it as {{queries.<name>.data}}) and the query itself:
- source "tooljetdb" — the default. Give the real id of a ToolJet DB table created earlier in this plan to list rows from.
- source "sql" — only when this step is meant to read from a data source the user has already connected. Give that source's real id and one SQL SELECT statement against a table that source actually has.

Every id must come from the context below, never invented. Prefer ToolJet DB unless the PRD or this step clearly asks for data that lives in a connected source.`;
