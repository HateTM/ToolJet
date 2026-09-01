import {
  validateLldSchema,
  parseLldSchema,
  LldValidationError,
  topologicallyOrderTables,
  buildLldStage,
} from '../../src/pipeline/lld';
import { LldSchema, StageContext } from '../../src/pipeline/types';

const usersTable = {
  table_name: 'users',
  columns: [
    { column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } },
    { column_name: 'name', data_type: 'character varying' },
  ],
};

const postsTable = {
  table_name: 'posts',
  columns: [
    { column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } },
    { column_name: 'user_id', data_type: 'integer' },
  ],
  foreign_keys: [{ column_name: 'user_id', references_table: 'users', references_column: 'id' }],
};

describe('validateLldSchema', () => {
  it('accepts a valid schema with no issues', () => {
    expect(validateLldSchema({ tables: [usersTable, postsTable] })).toEqual([]);
  });

  it('flags an empty schema', () => {
    expect(validateLldSchema({ tables: [] })).toEqual(['schema has no tables']);
  });

  it('flags a table with no primary key', () => {
    const schema: LldSchema = {
      tables: [{ table_name: 'orphans', columns: [{ column_name: 'note', data_type: 'text' }] }],
    };
    expect(validateLldSchema(schema)).toEqual(['table "orphans" has no primary key column']);
  });

  it('flags a duplicate table_name', () => {
    const schema: LldSchema = { tables: [usersTable, usersTable] };
    expect(validateLldSchema(schema)).toContain('duplicate table_name "users"');
  });

  it('flags seed data on a table (LLD is schema-only, no seeding)', () => {
    const schema = { tables: [{ ...usersTable, rows: [{ id: 1, name: 'a' }] }] } as unknown as LldSchema;
    expect(validateLldSchema(schema)[0]).toMatch(/carries seed data \(rows\)/);
  });

  it('flags a foreign key with no references_table', () => {
    const schema: LldSchema = {
      tables: [
        { ...postsTable, foreign_keys: [{ column_name: 'user_id', references_table: '', references_column: 'id' }] },
      ],
    };
    expect(validateLldSchema(schema)).toContain('table "posts" has a foreign key with no references_table');
  });

  it('flags a foreign key referencing a table absent from the schema', () => {
    const schema: LldSchema = {
      tables: [{ ...postsTable, foreign_keys: [{ ...postsTable.foreign_keys![0], references_table: 'ghosts' }] }],
    };
    expect(validateLldSchema(schema)).toContain('table "posts" has a foreign key referencing unknown table "ghosts"');
    expect(() => parseLldSchema(schema)).toThrow(LldValidationError);
  });
});

describe('parseLldSchema', () => {
  it('returns a valid schema unchanged', () => {
    const schema = { tables: [usersTable] };
    expect(parseLldSchema(schema)).toEqual(schema);
  });

  it('throws LldValidationError for a malformed payload', () => {
    expect(() => parseLldSchema('not a schema')).toThrow(LldValidationError);
  });

  it('throws LldValidationError with the collected issues for an invalid schema', () => {
    expect(() => parseLldSchema({ tables: [] })).toThrow(/schema has no tables/);
  });
});

describe('topologicallyOrderTables', () => {
  it('orders a dependency before its dependent', () => {
    const ordered = topologicallyOrderTables({ tables: [postsTable, usersTable] });
    const names = ordered.map((t) => t.table_name);
    expect(names.indexOf('users')).toBeLessThan(names.indexOf('posts'));
  });

  it('throws on a foreign-key cycle', () => {
    const a = {
      table_name: 'a',
      columns: [],
      foreign_keys: [{ column_name: 'b_id', references_table: 'b', references_column: 'id' }],
    };
    const b = {
      table_name: 'b',
      columns: [],
      foreign_keys: [{ column_name: 'a_id', references_table: 'a', references_column: 'id' }],
    };
    expect(() => topologicallyOrderTables({ tables: [a, b] })).toThrow(/cycle/);
  });

  it('throws on a foreign key referencing a table absent from the schema', () => {
    const schema: LldSchema = {
      tables: [{ ...postsTable, foreign_keys: [{ ...postsTable.foreign_keys![0], references_table: 'ghosts' }] }],
    };
    expect(() => topologicallyOrderTables(schema)).toThrow(/unknown table "ghosts"/);
  });
});

describe('buildLldStage', () => {
  const ctx: StageContext = { organizationId: 'org-1' };

  it('calls deps.generateLld with the PRD and stores the validated schema', async () => {
    const generateLld = jest.fn().mockResolvedValue({ tables: [usersTable] });
    const stage = buildLldStage({ generateLld });

    const result = await stage.run({ prompt: 'build a CRM', prd: '# PRD' }, ctx);

    expect(generateLld).toHaveBeenCalledWith('# PRD', ctx);
    expect(result.lld).toEqual({ tables: [usersTable] });
  });

  it('rejects an invalid LLD payload from the LLM', async () => {
    const generateLld = jest.fn().mockResolvedValue({ tables: [] });
    const stage = buildLldStage({ generateLld });

    await expect(stage.run({ prompt: 'build a CRM', prd: '# PRD' }, ctx)).rejects.toThrow(LldValidationError);
  });

  it('throws when artifacts.prd is missing instead of falling back to the raw prompt', async () => {
    const generateLld = jest.fn();
    const stage = buildLldStage({ generateLld });

    await expect(stage.run({ prompt: 'build a CRM' }, ctx)).rejects.toThrow('lld stage requires artifacts.prd');
    expect(generateLld).not.toHaveBeenCalled();
  });
});
