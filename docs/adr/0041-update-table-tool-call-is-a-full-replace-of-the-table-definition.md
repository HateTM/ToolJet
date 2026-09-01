# ADR-0041: The update-table tool call is a full-replace of the table's column definition

Date: 2026-09-01
Ticket: #111 (define the update-entity tool-call shape for per-entity generation)
Status: Accepted

## Context

`routeEntityToolCalls` (`generation-engine/src/pipeline/per-entity.ts`) routes an
entity that already exists to an `update` action with toolName `update_table`, but
until now nothing defined what that tool call carries: only `create-*` prompts exist
in the fork (ticket #93's known gap #4), and no TooljetDB-side action executes it.
Two shapes were on the table:

- **Full replace**: the tool call carries the complete desired column list; the
  executor diffs it against the table's current schema to produce adds/drops/
  type-changes.
- **Partial patch**: the tool call carries only the deltas (add these columns, drop
  those, change this type), which the executor applies more or less verbatim.

## Decision

**`update_table` is a full-replace of the table's column definition.** The tool-call
payload is:

- `table_name` — the table being updated (must equal the routed entity's name).
- `columns` — the **complete desired column list**, in the same shape the fork's
  `createTable` tool call already uses (the planner's `tableDefinitionObject`
  contract: `column_name`, `data_type`, `is_primary_key`, `is_not_null`, `is_unique`).
  Exactly one primary key column, as with create.
- `renames` — optional explicit map of `old_column_name -> new_column_name`. A rename
  tells the executor to move data (ALTER ... RENAME) instead of inferring drop+add,
  which would lose it.

The executor (server side) diffs the payload against the table's current schema
fetched via the ToolJet DB backend, and issues the resulting ALTERs through the
existing table-operations mechanism. `validateUpdateTableCall`
(`generation-engine/src/pipeline/per-entity.ts`) is the deterministic validator for
this shape, per ADR-0034's "unit-test the deterministic scaffolding" split.

Why full replace, not patch:

1. **Idempotent and unambiguous.** The same payload replayed against the same table
   produces the same (possibly empty) diff. A patch describes a transition, which is
   only meaningful relative to a schema the LLM may have stale knowledge of; a
   replace describes a state, and the executor — not the LLM — computes the
   transition against the real current schema.
2. **It mirrors how create already works.** `create-table.ts` prompts emit the
   complete definition verbatim (ADR-0020: the planned table is created exactly as
   previewed); a full-replace update reuses that same contract and shape, so one
   column schema serves both tool calls.
3. **Patch semantics would fork the fork's diff-merge complexity into schema land.**
   The frontend's UpdateComponent work already maintains one hand-rolled diff-merge
   (with its staleness and conflict hazards). Duplicating that in the schema
   executor buys nothing here: **generated tables are small** (single-digit
   columns), so the complete list is cheap to emit and cheap to diff.

Renames are the one piece of intent a pure state-diff cannot recover — a renamed
column is indistinguishable from drop-old + add-new — hence the explicit optional
`renames` map: it is the minimal patch-flavored escape hatch inside a
state-describing contract.

## Safety stance

- **Drops are allowed** — full replace implies them, and the plan (with the full
  desired schema) is user-approved before execution, same as the create path.
- **Two drops are refused outright** by the executor: dropping the table's primary
  key column, and dropping a column that is part of a foreign key. Both would leave
  the table (or its references) structurally broken, not merely empty a column.
- **Renames preserve data**: a rename is applied as a column rename, never
  drop + add, and a rename whose old name is not a current column (or whose new name
  collides with a surviving column) fails validation.
- All alters run through the ToolJet DB table-operations service's existing
  transactional path — no hand-concatenated SQL.

## Consequences

- The per-entity executor for `update` calls needs the table's current schema at
  execution time (a `view_table` round-trip), not just at plan time — the LLM is
  never trusted to know the current schema.
- An empty diff is a legitimate, successful no-op (e.g. the update only changed
  seed data or a component elsewhere), matching full-replace idempotency.
- Foreign-key and index changes are **out of scope** for v1: the payload carries
  columns only. If a later ticket needs them, the same full-replace principle
  extends naturally (carry the complete desired FK/index lists, diff, apply).
- `update_table` tool calls from the engine are validated deterministically before
  reaching the server, but the server re-validates (it must — it owns the current
  schema the diff runs against).
