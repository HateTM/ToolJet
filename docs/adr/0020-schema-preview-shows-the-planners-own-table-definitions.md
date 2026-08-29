---
status: accepted
---

# The schema preview shows the planner's own table definitions, and a previewed plan is the executed plan

> **Amended by [ADR-0024](0024-seed-data-is-planner-proposed-structured-rows-on-the-create-table-step.md) (ticket #48):** the "Rejected: seed data in v1" clause below rested on a false premise — ToolJet DB *does* have a bulk-insert capability in this fork — and is superseded there. Everything else in this ADR stands.

Ticket #20 asks for a structured schema/seed-data preview before a plan executes, with two paths — "Looks good, run it" and "I want to make changes" — and, optionally, inline editing of the generated SQL. The ticket was written against a reference UX where the schema exists as SQL text; our pipeline has no SQL anywhere, so the ticket's central question ("chat-described tweaks vs. direct SQL edit?") had to be answered first, and the answer reshapes the mechanics of the preview itself.

The proposed schema comes into existence at execution time. `executeCreateTableStep` makes a per-step LLM call (`createTable` tool) that invents the table's name, columns, and foreign keys when the step runs — after approval. A preview rendered before approval therefore cannot show "the SQL" or even "the table": nothing to preview exists yet. Something must propose the table earlier, and whatever does becomes the single source of truth the preview and the executor must share.

Decided: the planner proposes the tables. `proposeStepPlanTool`'s `CreateTable` steps now carry an optional `table` definition — the same shape the `createTableTool` used to define alone — persisted on the Step as `planned_table`. A new `preview-plan` endpoint generates (or reuses) the plan for the latest PRD and returns it as plain JSON, nothing executing. `executeCreateTableStep` creates a well-formed planned table **verbatim, with no LLM call**; only steps without one fall back to the old LLM path. The preview is therefore truthful by construction: what the preview rendered is byte-for-byte what `AgentsService.CreateTable` receives.

The approve flow becomes two-phase in effect, one-way in nature. `approvePrd` reuses pending Steps for the same PRD message instead of re-running the planner — a plan previewed is the plan executed, per ADR-0004's "the plan's shape doesn't change after approve". Refining the PRD produces a new AI message, whose empty pending set falls through to a fresh plan; a stale preview is discarded on `sendMessage` and on approve. The user-facing contract is unchanged: nothing is built until they explicitly run it.

**Rejected: inline SQL editing.** The reference UX implies editing SQL text directly, but there is no SQL to edit — the schema is structured JSON mapped onto `CreatePostgrestTableDto`. Editing SQL would mean adding a SQL parser to translate edits back into table params (new dependency, new dialect surface, new failure modes) purely so the user can edit a representation the pipeline doesn't use. If editing lands later, the right surface is the structured definition itself (add/rename/drop columns in the preview), not a text field that pretends SQL exists.

**Rejected: seed data in v1.** The ticket asks the preview to render seed rows, but ToolJet DB has no seed/bulk-insert operation — `perform('create_table', ...)` creates structure only, and the Form step's insert path is per-row, user-driven. Previewing seed data would promise data the executor cannot create, violating the one rule the preview exists to keep: it never shows something that won't be built. Seed support is an executor capability first, a preview feature second.

**Rejected: render the preview by parsing the PRD text.** The PRD is free markdown; extracting tables from prose means a second, non-LLM parser guessing at the model's intent, and the preview would then disagree with the planner — the exact drift the deterministic path avoids. (See also ADR-0019: the same principle — read structure from the model's tool-call output, not from text — is what the connected-sources block follows.)

**Rejected: hold the SSE stream open at approve for a confirmation.** The cheapest-looking option — emit the `plan` event and wait for a client "confirm" over the same connection — keeps a stream (and an LLM execution context) parked while a human reads a schema, for minutes if they walk away. The split endpoint costs one extra request and stores nothing new except the planned tables.

## What this settles elsewhere

**#21 (plan phases) and #15 (rollback) inherit the two-phase approve.** Any future step between "plan exists" and "plan executes" slots into the pending state this decision creates; nothing needs reordering.

**"I want to make changes" is a conversation action, not a regeneration.** It discards the preview and focuses the composer; the user types a targeted follow-up, the PRD is refined in place, and the next preview plans from the refined PRD. This is deliberately not ADR-0009's regenerate-message, which throws the whole reply away.

**The per-step LLM path stays, for now.** It remains the fallback for plans persisted before `planned_table` existed and for malformed planner output (a table with no name or no columns is dropped at plan time rather than trusted). A future ticket may make the fallback a hard error once planner reliability is measured.
