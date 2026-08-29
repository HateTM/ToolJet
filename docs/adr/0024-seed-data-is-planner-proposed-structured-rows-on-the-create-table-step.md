---
status: accepted
---

# Seed data is planner-proposed structured rows, inserted by the same CreateTable step that creates the table

Ticket #48 revisits ADR-0020's rejection of seed data. That rejection rested on one factual claim — "ToolJet DB has no seed/bulk-insert operation" — and the claim was wrong. A production study of a generated app on app.tooljet.ai (the "Personal Task Manager" app) shows the production generator seeds its apps, and our own fork already ships the server capability this fork's ADR declared missing: `TooljetDbBulkUploadService.bulkUpsertRowsWithPrimaryKey` performs bulk inserts with conflict handling against the ToolJet DB, no new server code required. The decision below therefore **amends** ADR-0020 (its schema-preview mechanics, inline-SQL rejection, and two-phase approve all stand untouched) and **supersedes only** its "Rejected: seed data in v1" clause; ADR-0020 carries the amendment banner.

## The decision

**Seed data is proposed by the planner, as structured rows — not SQL.** `proposeStepPlanTool`'s CreateTable steps carry an optional `seed_rows` field: an array of 1–50 plain records mapping column names to primitive-or-null values, persisted on the Step as `planned_seed_rows`. This is the same shape-as-JSON principle ADR-0020 set for the table definition itself: the preview renders the *data* (a small table of the exact rows), never a query, and no SQL parser or SQL text exists anywhere in the pipeline. ADR-0020's guardrail survives intact and even strengthens: seed data is part of the planned artifact, visible before approval, and the preview is truthful by construction — `executeCreateTableStep` inserts the planned rows verbatim, right after creating the planned table, with no LLM call on either half.

**Execution reuses the existing bulk upsert.** A new `AgentsService.SeedTable` delegates to `bulkUpsertRowsWithPrimaryKey(rows, tableId, primaryKeyColumns, organizationId)`. Rows that carry the primary key values upsert (the planner-expressible equivalent of the study app's `INSERT … ON CONFLICT DO NOTHING`); rows that omit a serial primary key plain-INSERT with the value auto-generated — so the conventional `id serial` primary key needs no invented values. A failed backend status throws into the step-execution retry loop like any other step error.

**Well-formedness gates both directions.** The same `isWellFormedSeedRows` policy as `isWellFormedTableDefinition`: a malformed planned seed-rows array is dropped at plan time (execution then creates the table without seeding) and re-checked at execution time (a seed that isn't trusted is skipped rather than half-executed). The planner prompt carries the guardrail explicitly: never invent seed rows the PRD does not call for.

## Rejected alternatives

**Rejected: a generated SQL query step (the production app's mechanism).** The ticket's own proposal — a `CreateQuery` step emitting `CREATE TABLE IF NOT EXISTS … ; INSERT … ON CONFLICT DO NOTHING` SQL — was the production generator's answer because it had no structured channel; we do. A SQL step would need a second statement-class guard (the read-only keyword check in `isSingleReadOnlyStatement` exists precisely because query SQL is untrusted), would surface DDL/SQL in a pipeline whose vocabulary deliberately avoids it (CONTEXT.md), and would duplicate the table definition the planner already proposes in structured form — the SQL and the planned_table would be two sources of truth for one schema, the exact drift ADR-0020 exists to prevent.

**Rejected: a separate SeedTable step type.** A step whose only input is "the table the previous step created" adds a plan-order dependency the executor must validate (what if it runs against the wrong table?) and a wire/undo/rollback surface (ticket #15) for data that is fully determined by the CreateTable step it belongs to. One step, one table, one artifact — seeding is part of that artifact's work.

**Rejected: idempotency via `ON CONFLICT DO NOTHING` semantics for rows without primary keys.** The bulk upsert needs primary key columns; rows omitting a serial PK plain-insert, so re-running a seed after a partial failure can duplicate rows. Accepting this is deliberate: the alternative (client-side dedup or a new server insert-or-ignore operation) adds capability for a failure window (table created, seed failed, retry) that already exists for the table itself — a retried `create_table` on an existing name fails the same way. The rewind path (ADR-0008) drops the whole table, so undo already cleans seed data.

## What this settles elsewhere

- **#15 (rollback)** treats seeded rows as part of the CreateTable step's artifact: `undoCreateTable` drops the table, seed data included. No new undo surface.
- **The schema preview (#20's component)** gains a "Sample data" section rendered from `seed_rows` on the wire step; the store passes steps through unchanged.
- **The per-step LLM fallback** never seeds: only planner-proposed `planned_seed_rows` are inserted. Plans persisted before this change behave exactly as before.
