/**
 * Pure diff-merge primitives for the UpdateQuery step (ticket #67, port of the EE
 * `updateQuery` idea, following the same read-merge-write shape ticket #66's
 * component-update.helper.ts established). The LLM is told to return only the `options`
 * paths that actually changed; these helpers turn that sparse patch into the full options
 * object DataQueryRepository.updateOne writes back (it replaces the whole jsonb `options`
 * column — there is no partial-jsonb-update path — so the merge has to happen here, before
 * the write, never after it), and capture exactly enough of the pre-patch state to undo it.
 *
 * `name` and `dataSourceId` are deliberately not part of this patch shape at all — the tool
 * contract only ever accepts an `options` patch (see UPDATE_QUERY_SYSTEM_PROMPT / the
 * updateQueryTool schema in service.ts), so a query's identity and its data source can never
 * be touched by an UpdateQuery step. That is what "read-only fields stay read-only" means
 * here, not a runtime check on this helper's input.
 */

import * as _ from 'lodash';

export type QueryOptionsPatch = Record<string, unknown>;

/** True when the patch has no keys at all — the "no changes" outcome the UpdateQuery tool
 * contract must accept without erroring, exactly like UpdateComponent's `{}`. */
export function isEmptyOptionsPatch(patch: QueryOptionsPatch | undefined | null): boolean {
  return !patch || Object.keys(patch).length === 0;
}

/**
 * Deep-merges `patch` onto `current`, with one deliberate departure from plain `_.merge`:
 * an array in the patch *replaces* the corresponding array in `current` rather than being
 * merged element-by-element. Query options carry arrays/keyed maps that are wholesale
 * values in this domain (a `where_filters`/columns map, a list of order-by clauses) — a
 * patch supplying `{ columns: { col_0: {...} } }` means "these are now the columns", the
 * same "patch replaces the value at this path" contract UpdateComponent's wrapped
 * properties/styles already use. Plain `_.merge` would instead splice the patch's array
 * entries onto the existing array index-by-index, silently keeping stale trailing entries.
 */
export function mergeQueryOptions(
  current: Record<string, unknown> | undefined,
  patch: QueryOptionsPatch | undefined
): Record<string, unknown> {
  if (isEmptyOptionsPatch(patch)) return { ...(current ?? {}) };
  return _.mergeWith({}, current ?? {}, patch, (_objValue: unknown, srcValue: unknown) => {
    if (Array.isArray(srcValue)) return srcValue;
    return undefined; // undefined tells mergeWith to fall back to its own default merge
  });
}

/**
 * The compensating-undo snapshot: the pre-patch value of every top-level key the patch is
 * about to touch, and nothing else — mirroring component-update.helper.ts's
 * snapshotPreviousSection. A key the query's options had no prior value for is omitted
 * rather than snapshotted as `undefined`/`null`, for the identical reason: restoring it
 * through the same merge can't truly delete it, only leave a worse value in its place. Known
 * gap, same as UpdateComponent's (see AgentsService.undoUpdateQuery): rewind of an UpdateQuery
 * that introduced a brand-new options key can't fully un-introduce it.
 */
export function snapshotPreviousOptions(
  current: Record<string, unknown> | undefined,
  patch: QueryOptionsPatch | undefined
): Record<string, unknown> {
  if (isEmptyOptionsPatch(patch)) return {};
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      snapshot[key] = current[key];
    }
  }
  return snapshot;
}
