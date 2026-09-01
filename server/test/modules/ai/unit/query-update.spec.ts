import { mergeQueryUpdate, validateMergedQueryOptions } from '../../../../src/modules/ai/services/query-update';
import { isSingleReadOnlyStatement } from '../../../../src/modules/ai/services/query-security';

describe('query-update (ticket #67: diff-merge of an existing query)', () => {
  const existingOptions = {
    operation: 'list_rows',
    table_id: 'tbl-1',
    list_rows: { limit: 100 },
  };

  describe('mergeQueryUpdate', () => {
    it('merges changed keys over the existing options and keeps untouched keys verbatim', () => {
      const merged = mergeQueryUpdate(existingOptions, {
        list_rows: { limit: 25 },
      });
      expect(merged).toEqual({
        operation: 'list_rows',
        table_id: 'tbl-1',
        list_rows: { limit: 25 },
      });
    });

    it('adds brand-new keys without disturbing the rest', () => {
      const merged = mergeQueryUpdate(existingOptions, {
        where_filters: { filter_0: { column: 'status', operator: 'eq', value: 'open' } },
      });
      expect(merged.table_id).toBe('tbl-1');
      expect(merged.list_rows).toEqual({ limit: 100 });
      expect(merged.where_filters).toEqual({
        filter_0: { column: 'status', operator: 'eq', value: 'open' },
      });
    });

    it('rejects an empty patch', () => {
      expect(() => mergeQueryUpdate(existingOptions, {})).toThrow();
    });

    it('rejects a non-object patch (arrays included)', () => {
      expect(() => mergeQueryUpdate(existingOptions, null)).toThrow();
      expect(() => mergeQueryUpdate(existingOptions, ['limit'])).toThrow();
      expect(() => mergeQueryUpdate(existingOptions, 'limit=25' as any)).toThrow();
    });

    it('rejects a non-object existing options', () => {
      expect(() => mergeQueryUpdate(null, { list_rows: { limit: 5 } })).toThrow();
    });
  });

  describe('validateMergedQueryOptions', () => {
    it('passes a merged options whose sql is a single read-only SELECT', () => {
      const merged = { mode: 'sql', query: 'SELECT id, name FROM users LIMIT 10' };
      expect(validateMergedQueryOptions(merged)).toBe(merged);
    });

    it('rejects a merged options whose sql contains a write statement', () => {
      expect(() => validateMergedQueryOptions({ mode: 'sql', query: 'DELETE FROM users' })).toThrow(/read-only/i);
    });

    it('rejects a sql update smuggled in after the select', () => {
      expect(() =>
        validateMergedQueryOptions({
          mode: 'sql',
          query: 'SELECT 1; DROP TABLE users',
        })
      ).toThrow();
    });

    it('ignores options that are not a sql-mode query', () => {
      const tooljetDb = { operation: 'list_rows', table_id: 'tbl-1' };
      expect(validateMergedQueryOptions(tooljetDb)).toBe(tooljetDb);
    });
  });

  describe('isSingleReadOnlyStatement (shared by CreateQuery and UpdateQuery)', () => {
    it('accepts a WITH statement and strips comments before validating', () => {
      expect(isSingleReadOnlyStatement('WITH t AS (SELECT 1) SELECT * FROM t')).toBe(true);
      expect(isSingleReadOnlyStatement('SELECT * FROM users -- ; DROP TABLE users')).toBe(true);
    });

    it('rejects multi-statement and write statements', () => {
      expect(isSingleReadOnlyStatement('SELECT 1; SELECT 2')).toBe(false);
      expect(isSingleReadOnlyStatement('UPDATE users SET name = null')).toBe(false);
      expect(isSingleReadOnlyStatement('')).toBe(false);
    });
  });
});
