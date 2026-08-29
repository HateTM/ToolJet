// Drives the @-mention completion source directly through CodeMirror's EditorState /
// CompletionContext — no DOM needed. The store module is stubbed (its import chain pulls
// ESM-only packages this jsdom jest setup can't parse); these tests only exercise the
// source and the pure filter it delegates to.
jest.mock('@/AppBuilder/_stores/store', () => ({ __esModule: true, default: jest.fn(() => ({})) }));

import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { mentionCompletionSource } from '../mentionCompletion';

const CATALOG = {
  pages: [{ id: 'page-1', name: 'Orders' }],
  components: [
    { id: 'comp-1', name: 'OrdersTable', widgetType: 'Table', pageId: 'page-1', pageName: 'Orders' },
    { id: 'comp-2', name: 'SubmitButton', widgetType: 'Button', pageId: 'page-1', pageName: 'Orders' },
  ],
  queries: [{ id: 'query-1', name: 'create_order', kind: 'tooljetdb' }],
};

const buildHarness = () => {
  const mentioned = [];
  const source = mentionCompletionSource({ getCatalog: () => CATALOG, onMentionSelect: (ref) => mentioned.push(ref) });
  const run = async (doc) => {
    const state = EditorState.create({ doc });
    const result = await source(new CompletionContext(state, doc.length, true));
    return { state, result, mentioned };
  };
  return { run };
};

describe('mentionCompletionSource (ticket #27)', () => {
  it('opens on a bare @ and offers all resource types with the mention start offset', async () => {
    const { run } = buildHarness();
    const { result: completion } = await run('@');

    expect(completion.from).toBe(0);
    expect(completion.options.map((option) => option.label)).toEqual([
      'Orders',
      'OrdersTable',
      'SubmitButton',
      'create_order',
    ]);
  });

  it('filters as the term grows and reports the option position after the @', async () => {
    const { run } = buildHarness();
    const { result } = await run('Wire @Ord');

    expect(result.from).toBe(5); // the '@'
    // 'Ord' is a substring of 'create_order' too — the pure filter matches by inclusion.
    expect(result.options.map((option) => option.label)).toEqual(['Orders', 'OrdersTable', 'create_order']);
  });

  it('does not open for an @ inside a word (email scenario)', async () => {
    const { run } = buildHarness();
    const { result } = await run('contact user@example.com');

    expect(result).toBeNull();
  });

  it('returns null when nothing matches the typed term', async () => {
    const { run } = buildHarness();
    const { result } = await run('@zzz');

    expect(result).toBeNull();
  });

  it('apply rewrites the @term into "@name ", parks the cursor after it, and reports the reference', async () => {
    const { run } = buildHarness();
    const doc = 'Wire @Ord';
    const { result, mentioned } = await run(doc);
    const option = result.options.find((candidate) => candidate.label === 'OrdersTable');

    // Assert on the dispatch spec (what the real EditorView would apply): the '@term' span
    // is replaced with '@name ' and the cursor lands after the inserted space.
    const specs = [];
    option.apply({ dispatch: (spec) => specs.push(spec) }, option, result.from, doc.length);

    expect(specs[0].changes).toEqual({ from: 5, to: 9, insert: '@OrdersTable ' });
    expect(specs[0].selection.anchor).toBe(18);
    expect(mentioned).toEqual([
      { id: 'comp-1', name: 'OrdersTable', widgetType: 'Table', pageId: 'page-1', pageName: 'Orders' },
    ]);
  });
});
