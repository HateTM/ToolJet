// server/test/modules/ai/unit/query-update.helper.spec.ts
import {
  isEmptyOptionsPatch,
  mergeQueryOptions,
  snapshotPreviousOptions,
} from '@modules/ai/helpers/query-update.helper';

/** @group platform */
describe('isEmptyOptionsPatch (ticket #67)', () => {
  it('is true for undefined/null/{} — the "no changes" outcome the LLM contract requires', () => {
    expect(isEmptyOptionsPatch(undefined)).toBe(true);
    expect(isEmptyOptionsPatch(null as any)).toBe(true);
    expect(isEmptyOptionsPatch({})).toBe(true);
  });

  it('is false once the patch carries a key', () => {
    expect(isEmptyOptionsPatch({ table_id: 'orders' })).toBe(false);
  });
});

describe('mergeQueryOptions', () => {
  const current = {
    operation: 'list_rows',
    table_id: 'orders',
    list_rows: { limit: 10, where_filters: { filter_0: { column: 'status', operator: 'eq', value: 'open' } } },
  };

  it('merges a sparse patch onto current options without clobbering keys the patch never mentioned', () => {
    const merged = mergeQueryOptions(current, { list_rows: { limit: 25 } });
    expect(merged).toEqual({
      operation: 'list_rows',
      table_id: 'orders',
      list_rows: { limit: 25, where_filters: { filter_0: { column: 'status', operator: 'eq', value: 'open' } } },
    });
  });

  it('replaces an array wholesale rather than merging it element-by-element', () => {
    const withArray = { order_by: [{ column: 'id', direction: 'asc' }] };
    const merged = mergeQueryOptions(withArray, { order_by: [{ column: 'created_at', direction: 'desc' }] });
    expect(merged.order_by).toEqual([{ column: 'created_at', direction: 'desc' }]);
  });

  it('returns a copy of current unchanged when the patch is empty', () => {
    expect(mergeQueryOptions(current, {})).toEqual(current);
    expect(mergeQueryOptions(current, undefined)).toEqual(current);
  });

  it('handles an absent current (query with no prior options)', () => {
    expect(mergeQueryOptions(undefined, { table_id: 'orders' })).toEqual({ table_id: 'orders' });
  });
});

describe('snapshotPreviousOptions (compensating undo, ticket #67)', () => {
  const current = { operation: 'list_rows', table_id: 'orders', list_rows: { limit: 10 } };

  it('captures only the top-level keys the patch touches', () => {
    const snapshot = snapshotPreviousOptions(current, { list_rows: { limit: 25 } });
    expect(snapshot).toEqual({ list_rows: { limit: 10 } });
    expect(snapshot).not.toHaveProperty('table_id');
    expect(snapshot).not.toHaveProperty('operation');
  });

  it('omits a key current options had no prior value for (documented undo limitation)', () => {
    expect(snapshotPreviousOptions(current, { brandNewKey: 'x' })).toEqual({});
  });

  it('returns {} for an empty/absent patch', () => {
    expect(snapshotPreviousOptions(current, undefined)).toEqual({});
    expect(snapshotPreviousOptions(current, {})).toEqual({});
  });
});
