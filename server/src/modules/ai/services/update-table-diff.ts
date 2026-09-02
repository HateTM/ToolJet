// Ticket #111 / ADR-0041: the `update_table` tool call is a full replace of a ToolJet DB
// table's column definition. This module is the deterministic half of executing one: it
// diffs the desired column list against the table's real current schema (fetched by the
// caller via TooljetDbTableOperationsService's 'view_table' action) and produces the
// old_column/new_column entries the existing 'edit_table' action applies transactionally.
// Pure and side-effect free — unit-tested in test/modules/ai/unit/update-table-diff.spec.ts.

export interface CurrentTjdbColumn {
  column_name: string;
  data_type: string;
  column_default?: string | null;
  constraints_type?: {
    is_primary_key?: boolean;
    is_not_null?: boolean;
    is_unique?: boolean;
  };
}

export interface DesiredTjdbColumn {
  column_name: string;
  data_type: string;
  constraints_type: {
    is_primary_key: boolean;
    is_not_null: boolean;
    is_unique: boolean;
  };
  column_default?: string | number | boolean | null;
}

// Exactly TooljetDbTableOperationsService.editTable's per-column entry shape: an empty
// new_column means "drop old_column", an empty old_column means "add new_column", both
// present means "alter old_column into new_column" (which also covers a rename).
export interface UpdateTableDiffEntry {
  old_column: CurrentTjdbColumn | Record<string, never>;
  new_column: DesiredTjdbColumn | Record<string, never>;
}

export interface TableUpdateDiff {
  entries: UpdateTableDiffEntry[];
  /** Non-empty means the update must not be executed (see ADR-0041's safety stance). */
  refusals: string[];
  /** True when the desired schema is already the current schema — a legitimate no-op. */
  noOp: boolean;
}

/**
 * Validates the desired half of an update_table call (the same checks the engine's
 * validateUpdateTableCall applies per ADR-0034's deterministic-scaffolding split). The
 * server re-validates because it owns the execution. Returns the list of problems —
 * empty means valid.
 */
export function validateDesiredColumns(columns: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(columns) || columns.length === 0) {
    return ['update_table payload must carry a non-empty columns list'];
  }

  const names = new Set<string>();
  for (const column of columns as DesiredTjdbColumn[]) {
    if (!column || typeof column.column_name !== 'string' || !column.column_name) {
      problems.push('update_table payload has a column without a column_name');
      continue;
    }
    if (names.has(column.column_name)) {
      problems.push(`update_table payload lists column "${column.column_name}" more than once`);
    }
    names.add(column.column_name);
    if (typeof column.data_type !== 'string' || !column.data_type) {
      problems.push(`column "${column.column_name}" has no data_type`);
    }
    if (typeof column?.constraints_type?.is_primary_key !== 'boolean') {
      problems.push(`column "${column.column_name}" has no boolean is_primary_key constraint`);
    }
  }
  const primaryKeys = (columns as DesiredTjdbColumn[]).filter((c) => c?.constraints_type?.is_primary_key === true);
  if (primaryKeys.length !== 1) {
    problems.push(`update_table payload must have exactly one primary key column, found ${primaryKeys.length}`);
  }
  return problems;
}

/**
 * Diffs the desired full-replace column list against the table's current columns.
 *
 * - `renames` (ADR-0041) is an explicit old->new map: a rename is emitted as an
 *   alter (old_column -> new_column), never drop+add, so the column's data survives.
 * - `fkColumnNames` are the columns involved in the table's foreign keys (from
 *   view_table's foreign_keys); dropping one would leave the reference structurally
 *   broken, so it is refused — as is dropping the table's primary key column (ADR-0041,
 *   safety stance). Other drops are allowed: the plan was user-approved.
 */
export function diffTableColumns(
  current: CurrentTjdbColumn[],
  desired: DesiredTjdbColumn[],
  renames: Record<string, string> | undefined,
  options: { tableName: string; fkColumnNames?: ReadonlySet<string> }
): TableUpdateDiff {
  const { tableName, fkColumnNames = new Set() } = options;
  const refusals: string[] = validateDesiredColumns(desired);
  if (refusals.length) return { entries: [], refusals, noOp: false };

  const currentByName = new Map(current.map((column) => [column.column_name, column]));
  const desiredByName = new Map(desired.map((column) => [column.column_name, column]));

  // Validate renames against both sides: the old name must be a current column, the new
  // name must be a desired column, and the old name must disappear from the desired list
  // (otherwise it isn't a rename but a no-op-ish duplicate).
  const oldByNew = new Map<string, string>();
  for (const [from, to] of Object.entries(renames ?? {})) {
    if (!currentByName.has(from)) {
      refusals.push(`rename source "${from}" is not a current column of "${tableName}"`);
    }
    if (!desiredByName.has(to)) {
      refusals.push(`rename target "${to}" is not a column in the desired columns list`);
    }
    if (desiredByName.has(from)) {
      refusals.push(`rename source "${from}" is also in the desired columns list — a rename's old name must not be`);
    }
    if (oldByNew.has(to)) {
      refusals.push(`rename target "${to}" is the target of more than one rename`);
    }
    // Renaming "from" onto a current column that itself survives under its own name would
    // collide mid-transaction; a target name is only free if its current occupant is
    // dropped, or itself renamed away, by this same update.
    if (to !== from && currentByName.has(to) && desiredByName.has(to) && !(to in (renames ?? {}))) {
      refusals.push(`rename target "${to}" collides with the existing column "${to}"`);
    }
    oldByNew.set(to, from);
  }

  const entries: UpdateTableDiffEntry[] = [];

  // Alters: every desired column whose predecessor (after applying renames) exists.
  const changedColumns = new Set<DesiredTjdbColumn>();
  for (const column of desired) {
    const previousName = oldByNew.get(column.column_name) ?? column.column_name;
    const existing = currentByName.get(previousName);
    if (!existing) continue;

    const constraints = column.constraints_type;
    const currentConstraints = existing.constraints_type ?? {};
    const differs =
      previousName !== column.column_name ||
      existing.data_type !== column.data_type ||
      Boolean(currentConstraints.is_primary_key) !== Boolean(constraints.is_primary_key) ||
      Boolean(currentConstraints.is_not_null) !== Boolean(constraints.is_not_null) ||
      Boolean(currentConstraints.is_unique) !== Boolean(constraints.is_unique);
    if (differs) {
      entries.push({ old_column: existing, new_column: column });
      changedColumns.add(column);
    }
  }

  // Adds: desired columns with no current predecessor.
  for (const column of desired) {
    const previousName = oldByNew.get(column.column_name) ?? column.column_name;
    if (!currentByName.has(previousName)) {
      entries.push({ old_column: {}, new_column: column });
      changedColumns.add(column);
    }
  }

  // Drops: current columns that survive neither under their own name nor as a rename
  // source. Destructive ones are refused outright per ADR-0041.
  for (const column of current) {
    const survives = desiredByName.has(column.column_name) || [...oldByNew.values()].includes(column.column_name);
    if (survives) continue;

    if (column.constraints_type?.is_primary_key) {
      refusals.push(`dropping the primary key column "${column.column_name}" is not allowed`);
    }
    if (fkColumnNames.has(column.column_name)) {
      refusals.push(`dropping column "${column.column_name}" is not allowed: it is part of a foreign key`);
    }
    entries.push({ old_column: column, new_column: {} });
  }

  if (refusals.length) return { entries: [], refusals, noOp: false };

  // edit_table refuses any call whose new_columns carry no primary key (it rebuilds the
  // primary key from them), so when there are changes, always ride the desired PK column
  // as an alter entry — unchanged if it has to be. When nothing changed at all, the whole
  // update is a legitimate no-op and skips edit_table entirely.
  const desiredPrimaryKey = desired.find((column) => column.constraints_type.is_primary_key);
  if (entries.length > 0 && desiredPrimaryKey && !changedColumns.has(desiredPrimaryKey)) {
    entries.push({ old_column: currentByName.get(desiredPrimaryKey.column_name)!, new_column: desiredPrimaryKey });
  }

  return { entries, refusals: [], noOp: entries.length === 0 };
}
