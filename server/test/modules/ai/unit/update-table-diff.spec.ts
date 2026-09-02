import {
  diffTableColumns,
  validateDesiredColumns,
  DesiredTjdbColumn,
  CurrentTjdbColumn,
} from '@modules/ai/services/update-table-diff';

const pk = (name: string): DesiredTjdbColumn => ({
  column_name: name,
  data_type: 'serial',
  constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
});

const col = (
  name: string,
  data_type = 'character varying',
  overrides: Partial<DesiredTjdbColumn> = {}
): DesiredTjdbColumn => ({
  column_name: name,
  data_type,
  constraints_type: { is_primary_key: false, is_not_null: false, is_unique: false },
  ...overrides,
});

const cur = (
  name: string,
  data_type = 'character varying',
  constraints: CurrentTjdbColumn['constraints_type'] = {}
): CurrentTjdbColumn => ({
  column_name: name,
  data_type,
  constraints_type: constraints,
});

const opts = { tableName: 'users' };

describe('validateDesiredColumns', () => {
  it('accepts a well-formed full-replace column list', () => {
    expect(validateDesiredColumns([pk('id'), col('email')])).toEqual([]);
  });

  it('flags an empty list and duplicate/missing fields', () => {
    expect(validateDesiredColumns([])).toEqual(['update_table payload must carry a non-empty columns list']);
    expect(validateDesiredColumns([pk('id'), col('email') as any, col('email')])).toContain(
      'update_table payload lists column "email" more than once'
    );
    expect(validateDesiredColumns([{ column_name: 'x', data_type: 'integer' } as any])).toContain(
      'column "x" has no boolean is_primary_key constraint'
    );
  });

  it('flags zero and multiple primary keys', () => {
    expect(validateDesiredColumns([col('email')])).toContain(
      'update_table payload must have exactly one primary key column, found 0'
    );
    expect(validateDesiredColumns([pk('id'), pk('other')])).toContain(
      'update_table payload must have exactly one primary key column, found 2'
    );
  });
});

describe('diffTableColumns', () => {
  it('returns a no-op when the desired list matches the current schema', () => {
    const current = [cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }), cur('email')];
    const desired = [pk('id'), col('email')];
    const diff = diffTableColumns(current, desired, undefined, opts);
    expect(diff).toEqual({ entries: [], refusals: [], noOp: true });
  });

  it('emits adds for new columns and drops for omitted ones', () => {
    const current = [
      cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }),
      cur('old_field'),
    ];
    const desired = [pk('id'), col('email')];
    const diff = diffTableColumns(current, desired, undefined, opts);
    expect(diff.noOp).toBe(false);
    expect(diff.entries).toEqual([
      { old_column: {}, new_column: col('email') },
      { old_column: cur('old_field'), new_column: {} },
      // PK rider entry (unchanged), because edit_table rebuilds the primary key from
      // new_columns and refuses a diff that carries none.
      { old_column: current[0], new_column: desired[0] },
    ]);
  });

  it('emits an alter when type or constraints change', () => {
    const current = [cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }), cur('email')];
    const desired = [
      pk('id'),
      col('email', 'character varying', {
        constraints_type: { is_primary_key: false, is_not_null: true, is_unique: false },
      }),
    ];
    const diff = diffTableColumns(current, desired, undefined, opts);
    // The desired PK rides along unchanged (edit_table rebuilds the primary key from
    // new_columns) — see diffTableColumns' PK-rider comment.
    expect(diff.entries).toEqual([
      { old_column: cur('email'), new_column: desired[1] },
      { old_column: current[0], new_column: desired[0] },
    ]);
  });

  it('keeps the primary key entry in the diff so edit_table can rebuild it', () => {
    const current = [cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }), cur('email')];
    const desired = [pk('id'), col('email', 'integer')];
    const diff = diffTableColumns(current, desired, undefined, opts);
    expect(diff.entries.map((entry) => entry.old_column.column_name)).toContain('id');
  });

  it('expresses a rename as an alter, not drop+add, and refuses an unknown rename source', () => {
    const current = [
      cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }),
      cur('user_name'),
    ];
    const desired = [pk('id'), col('name')];
    const diff = diffTableColumns(current, desired, { user_name: 'name' }, opts);
    expect(diff.refusals).toEqual([]);
    expect(diff.entries).toEqual([
      { old_column: cur('user_name'), new_column: col('name') },
      { old_column: current[0], new_column: desired[0] },
    ]);

    const bad = diffTableColumns(current, desired, { missing_column: 'name' }, opts);
    expect(bad.refusals).toContain('rename source "missing_column" is not a current column of "users"');
  });

  it('refuses dropping the primary key column', () => {
    const current = [cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }), cur('email')];
    const desired = [pk('other_id'), col('email')];
    const diff = diffTableColumns(current, desired, undefined, opts);
    expect(diff.entries).toEqual([]);
    expect(diff.refusals).toContain('dropping the primary key column "id" is not allowed');
  });

  it('refuses dropping a column that is part of a foreign key', () => {
    const current = [
      cur('id', 'serial', { is_primary_key: true, is_not_null: true, is_unique: true }),
      cur('customer_id'),
    ];
    const desired = [pk('id')];
    const diff = diffTableColumns(current, desired, undefined, { ...opts, fkColumnNames: new Set(['customer_id']) });
    expect(diff.entries).toEqual([]);
    expect(diff.refusals).toContain('dropping column "customer_id" is not allowed: it is part of a foreign key');
  });

  it('propagates invalid desired lists as refusals without entries', () => {
    const diff = diffTableColumns(
      [cur('id', 'serial', { is_primary_key: true })],
      [col('a'), col('a')],
      undefined,
      opts
    );
    expect(diff.entries).toEqual([]);
    expect(diff.refusals).toContain('update_table payload lists column "a" more than once');
  });
});
