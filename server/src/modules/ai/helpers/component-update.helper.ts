/**
 * Pure diff-merge primitives for the UpdateComponent step (ticket #66, port of the EE
 * `updateComponent`/`updateSingleComponent` idea). The LLM is told to return only the
 * paths it actually changed ("return ONLY the paths that were modified", "{}" for no
 * changes) — these helpers turn that sparse patch into the wrapped shape
 * `sanitizeComponentSection` (ticket #60) and `Component.properties`/`Component.styles`
 * both use, and capture exactly enough of the pre-patch state to undo it later.
 *
 * The actual merge onto the component's stored properties/styles happens one layer up, in
 * ComponentsService.update's own `_.mergeWith` — these helpers never touch the full current
 * object, only the keys a given patch names, which is what keeps a patch from ever
 * overwriting a sibling property/style it didn't mention.
 */

export type ComponentPropertyPatch = Record<string, unknown>;

// The event half of a patch (ticket #67): binds/updates one EventHandler on the target
// component. `eventId` must be one of the component type's real event ids
// (widget-meta.ts's getEventIds, sourced from componentsMeta.json's `events` list);
// `actionId` one of the curated action ids AgentsService.UpdateComponent recognizes. Every
// other key is an action-specific field carried verbatim onto the stored event JSON (e.g.
// `modal` for show-modal, `queryId`/`queryName` for run-query) — never invented here, just
// passed through.
export interface ComponentEventPatch {
  eventId: string;
  actionId: string;
  [key: string]: unknown;
}

export interface ComponentUpdatePatch {
  properties?: ComponentPropertyPatch;
  styles?: ComponentPropertyPatch;
  event?: ComponentEventPatch;
}

function isEmptySection(section?: ComponentPropertyPatch): boolean {
  return !section || Object.keys(section).length === 0;
}

/** True when a patch touches neither properties, styles, nor an event — the "no changes"
 * outcome the UpdateComponent tool contract must accept without erroring. An event-only
 * patch (binding a new event to an existing component with no property/style change) is
 * therefore NOT empty — this is what keeps it from being silently dropped as a no-op. */
export function isEmptyPatch(patch: ComponentUpdatePatch | undefined | null): boolean {
  if (!patch) return true;
  return isEmptySection(patch.properties) && isEmptySection(patch.styles) && !patch.event;
}

/** Wraps a flat `{ propName: value }` patch into the `{ propName: { value } }` shape
 * `sanitizeComponentSection` and the Component entity's `properties`/`styles` columns store.
 * Returns `undefined` (not `{}`) for an absent section, so the caller can tell "this step
 * didn't touch styles at all" apart from "this step cleared styles to nothing". */
export function wrapPatchSection(section?: ComponentPropertyPatch): Record<string, { value: unknown }> | undefined {
  if (!section) return undefined;
  return Object.fromEntries(Object.entries(section).map(([key, value]) => [key, { value }]));
}

/**
 * The compensating-undo snapshot for one section: the pre-patch, wrapped value of every key
 * the patch is about to touch, and nothing else. A key the component had no prior value for
 * (the patch is introducing it) is deliberately omitted rather than snapshotted as `null` —
 * feeding a `null` back through ComponentsService.update's merge would leave the key present
 * with a null value, not truly remove it, which is a worse rewind than leaving the key alone.
 * Known gap (see ticket #66 PR): rewinding an UpdateComponent that introduced a brand-new
 * property therefore cannot fully un-introduce it — flagged rather than silently guessed at.
 */
export function snapshotPreviousSection(
  current: Record<string, unknown> | undefined,
  patchSection?: ComponentPropertyPatch
): Record<string, unknown> {
  if (!patchSection) return {};
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(patchSection)) {
    if (current && Object.prototype.hasOwnProperty.call(current, key)) {
      snapshot[key] = current[key];
    }
  }
  return snapshot;
}
