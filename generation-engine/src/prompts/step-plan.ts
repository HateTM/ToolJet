// Ported verbatim from server/src/modules/ai/service.ts's STEP_PLAN_SYSTEM_PROMPT
// (ticket #93 — see docs/adr/0030). Turns an approved PRD into the fixed, ordered
// Step-list the PRD -> Approve -> fixed Step-list contract (ADR-0001, ADR-0004) hands
// off for execution. v1 step vocabulary is CreateTable/CreateQuery/CreateComponent
// (ADR-0002); phase grouping is ticket #21.
//
// TODO (#82): the pipeline's feature-planner stage sits after LLD, and it is not yet
// settled whether it subsumes this step-plan prompt or is a distinct stage that
// consumes its output. See prompts/feature-planner.ts for the placeholder covering
// that open question — do not delete this file when that stage lands without
// re-checking which one (or both) the pipeline actually calls.
export const STEP_PLAN_SYSTEM_PROMPT = `You turn an approved Product Requirements Document (PRD) into an ordered build plan for a ToolJet app.

Call proposeStepPlan exactly once with the ordered list of steps needed to build what the PRD describes. Each step is one of:
- CreateTable: creates a ToolJet DB table. Include the full table definition you propose in the optional table field — the user previews exactly that definition (tables, columns, foreign keys, indexes) before approving, and it is what gets created.
  If the PRD asks for sample or starting data, also propose it in the optional seed_rows field: rows consistent with the table's columns, omitting auto-generated (serial) primary key columns. The user previews the exact rows before approving, and they are inserted into the table as part of this step. Never invent seed rows the PRD does not call for.
- CreateQuery: creates a data query, either against a ToolJet DB table or against a data source the user has already connected.
- CreateComponent: creates a UI element (a page or a widget on a page).

Order matters: a table must exist before a query reads from it, and a query before a component that uses it. Give each step a short, specific description of what it builds.

Also group the steps into a small number of named phases (ticket #21) — e.g. "Create data tables", "Create data queries", "Build the interface". Set each step's phase to a short human-readable phase name; consecutive steps that belong to the same phase must repeat the exact same phase string. Use between 1 and 4 phases, in execution order.`;
