import useStore from '@/AppBuilder/_stores/store';
import { shallow } from 'zustand/shallow';
import { useMemo } from 'react';

/**
 * The @-mention catalog (ticket #27): every page, component, and query the current app
 * version has, snapshotted from the builder's live store — the same objects the AI's
 * context already enumerates, so a mention resolves to a real id the backend can act on.
 *
 * Raw slices are selected with `shallow` (page/query objects are stable store refs, so
 * unrelated builder updates don't re-render the panel), and the derived shape is built in
 * a memo on top of them.
 */
export const useMentionCatalog = () => {
  const pages = useStore((state) => state.modules?.canvas?.pages ?? [], shallow);
  const queries = useStore((state) => state.dataQuery?.queries?.modules?.canvas ?? [], shallow);

  return useMemo(
    () => ({
      pages: pages.map((page) => ({ id: page.id, name: page.name })),
      components: pages.flatMap((page) =>
        Object.entries(page.components ?? {}).map(([id, entry]) => ({
          id,
          name: entry?.component?.name,
          widgetType: entry?.component?.component,
          pageId: page.id,
          pageName: page.name,
        }))
      ),
      queries: queries.map((query) => ({ id: query.id, name: query.name, kind: query.kind })),
    }),
    [pages, queries]
  );
};

// Pure option-building over a catalog, so the filtering rules are testable without CM.
export const filterMentionOptions = (catalog, term) => {
  const query = (term ?? '').toLowerCase();
  const matches = (name) => typeof name === 'string' && name.toLowerCase().includes(query);
  const options = [
    ...(catalog?.pages ?? [])
      .filter((page) => matches(page.name))
      .map((page) => ({ label: page.name, detail: 'Page', type: 'page', reference: page })),
    ...(catalog?.components ?? [])
      .filter((component) => matches(component.name))
      .map((component) => ({
        label: component.name,
        detail: `${component.widgetType} on ${component.pageName}`,
        type: 'component',
        reference: component,
      })),
    ...(catalog?.queries ?? [])
      .filter((query2) => matches(query2.name))
      .map((query2) => ({ label: query2.name, detail: `${query2.kind} query`, type: 'query', reference: query2 })),
  ];
  return options;
};
