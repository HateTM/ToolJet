/**
 * Pure validation for the `event` half of an UpdateComponent patch (ticket #67, port of the
 * EE "generate/update events" idea — scoped down per the issue's own risk-flag comment: a
 * full component-event *catalog builder* is expected to be superseded once the Generation
 * engine (ADR-0033) lands, so this only validates against the hand-maintained snapshot
 * already checked in for ticket #66's sanitizer, componentsMeta.json).
 *
 * `ACTION_IDS` is a curated subset of the platform's real action ids — copied verbatim from
 * frontend/src/AppBuilder/RightSideBar/Inspector/ActionTypes.js, never invented — restricted
 * to the actions an AI-authored event plausibly needs (open/close a Modal, run a query the
 * plan itself created, a bare alert, an external link). The full ActionTypes list (control-
 * component, set-table-page, switch-page, go-to-app, ...) is deliberately NOT exposed yet:
 * each of those needs its own target-existence check the way `show-modal`'s `modal` and
 * `run-query`'s `queryId` do, which is future work, not guessed at here.
 */

export const ACTION_IDS = [
  'run-query',
  'reset-query',
  'abort-query',
  'show-modal',
  'close-modal',
  'show-alert',
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export function isKnownActionId(actionId: string): actionId is ActionId {
  return (ACTION_IDS as readonly string[]).includes(actionId);
}

export interface EventPatchInput {
  eventId?: string;
  actionId?: string;
  [key: string]: unknown;
}

export interface EventValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * `getEventIds` is passed in (rather than imported from widget-meta.ts directly) so this
 * stays a pure function over its inputs — the same seam component-update.helper.ts's own
 * functions keep, and what makes both trivially unit-testable without componentsMeta.json
 * fixtures.
 */
export function validateEventPatch(
  componentType: string,
  patch: EventPatchInput,
  knownEventIds: string[]
): EventValidationResult {
  if (!patch?.eventId) {
    return { valid: false, error: 'event.eventId is required' };
  }
  if (!knownEventIds.includes(patch.eventId)) {
    return {
      valid: false,
      error: `"${patch.eventId}" is not a real event of ${componentType} (known: ${knownEventIds.join(', ') || 'none'})`,
    };
  }
  if (!patch.actionId) {
    return { valid: false, error: 'event.actionId is required' };
  }
  if (!isKnownActionId(patch.actionId)) {
    return {
      valid: false,
      error: `"${patch.actionId}" is not a supported action id (known: ${ACTION_IDS.join(', ')})`,
    };
  }
  return { valid: true };
}
