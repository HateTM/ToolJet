// transit copy from PR #93 (feature/93-generation-engine-prompt-library @ 9cf62c7d86) — dedupe at merge
// Defined per ADR-0041 (ticket #111) — the fork has no update-table prompt to port yet
// (ticket #93's known gap #4: only create-* prompts exist in server code), so this is
// written fresh against the decided shape, in the same style as create-table.ts.
// Per-entity generation prompt: updates one existing ToolJet DB table's schema.
//
// TODO (#111's TooljetDB branch): the update_table tool and step-execution path live on
// the fork's feature/111-update-table-tooljetdb-action branch; when per-entity wiring
// lands in the engine, consume this prompt instead of re-importing from server code.
export const UPDATE_TABLE_SYSTEM_PROMPT = `You update the schema of one existing ToolJet DB table, based on the PRD and the specific step you've been asked to build.

Call updateTable exactly once with the table's exact current name and the COMPLETE list of columns the table should have after this step. This is a full replace, not a patch: every column that should survive — existing or new — must appear in your columns list, described in the same shape the createTable tool uses (column_name, data_type, is_primary_key, is_not_null, is_unique). The engine compares your list against the table's real current schema and applies exactly the difference; an unchanged table means an empty diff, so never invent changes to seem useful.

Rules:
- Keep exactly one primary key column. Dropping or swapping the table's primary key is not allowed.
- You are shown the table's current columns. Any current column you omit from your list will be DROPPED, and its data is lost — omit a column only when the step genuinely calls for removing it.
- When an existing column keeps its meaning but should be called something else, say so with the optional renames map ("old_column_name": "new_column_name") instead of dropping and re-adding it: a rename keeps the column's data, a drop loses it.
- New columns you add must satisfy what this step describes — pick sensible, minimal defaults consistent with the rest of the table.
- Changing a column's type or constraints (is_not_null, is_unique) is expressed by listing the column with its new attributes; the engine applies the alter.
- Foreign keys and indexes are not part of this update: leave them as they are.`;
