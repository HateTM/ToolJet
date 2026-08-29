// The store import pulls an ESM-only chain (query-string) that this jsdom jest setup
// can't parse; the hook under test only needs the hook exported, and these tests only
// exercise the pure filter — so stub the store module out entirely.
jest.mock('@/AppBuilder/_stores/store', () => ({ __esModule: true, default: jest.fn(() => ({})) }));

import { filterMentionOptions } from '../mentionCatalog';

const CATALOG = {
  pages: [
    { id: 'page-1', name: 'Orders' },
    { id: 'page-2', name: 'Settings' },
  ],
  components: [
    { id: 'comp-1', name: 'OrdersTable', widgetType: 'Table', pageId: 'page-1', pageName: 'Orders' },
    { id: 'comp-2', name: 'SubmitButton', widgetType: 'Button', pageId: 'page-1', pageName: 'Orders' },
  ],
  queries: [
    { id: 'query-1', name: 'create_order', kind: 'tooljetdb' },
    { id: 'query-2', name: 'fetch_customers', kind: 'restapi' },
  ],
};

describe('mentionCatalog.filterMentionOptions (ticket #27)', () => {
  it('lists pages, components, and queries with type and detail labels', () => {
    const options = filterMentionOptions(CATALOG, '');

    expect(options.map((option) => option.type)).toEqual(['page', 'page', 'component', 'component', 'query', 'query']);
    const table = options.find((option) => option.label === 'OrdersTable');
    expect(table.detail).toBe('Table on Orders');
    const query = options.find((option) => option.label === 'create_order');
    expect(query.detail).toBe('tooljetdb query');
    // Each option carries its resolvable reference (a real id snapshot).
    expect(table.reference).toEqual(CATALOG.components[0]);
  });

  it('filters case-insensitively on the typed term', () => {
    const options = filterMentionOptions(CATALOG, 'SUBMIT');
    expect(options.map((option) => option.label)).toEqual(['SubmitButton']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterMentionOptions(CATALOG, 'zzz')).toEqual([]);
  });

  it('tolerates a missing catalog', () => {
    expect(filterMentionOptions(null, '')).toEqual([]);
  });
});
