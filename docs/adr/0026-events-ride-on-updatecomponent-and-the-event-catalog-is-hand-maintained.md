# ADR-0026: Events ride on UpdateComponent, not a new StepType; the event catalog is a hand-maintained componentsMeta.json snapshot

Date: 2026-09-01
Ticket: #67 (UpdateQuery and event generation — blocked by #66)
Status: Accepted

## Context

Ticket #67 ports two EE ideas: `updateQuery` (a diff-merge onto an existing query's options, mirroring #66's UpdateComponent) and `generateEvent`/`updateEvent` (binding an event to a component from a machine list of the platform's real event types, with the quality rule "a request for a Table's row-click event must produce the component's own `onRowClicked`, never a design-language guess like `onRowClick`"). Two decisions had to be made: where event binding lives in the Step taxonomy, and what grounds the "real event types" list.

## Decision

**Events ride on the existing `UpdateComponent` StepType**, as a third, independent arm of its patch (`{ properties?, styles?, event? }`) rather than a new `CreateEvent`/`UpdateEvent` StepType. An event patch already needs exactly the same real-`componentId` grounding UpdateComponent's `properties`/`styles` patches already require (`AppInventoryService.renderComponentIndex`), and the "no duplicate handler" rule this ticket asks for is a dedup-on-`eventId` lookup against `EventsService.findAllEventsWithSourceId(componentId)` — a per-component operation, not a per-StepType one. `isEmptyPatch` was extended so an event-only patch (no property/style change) is not mistaken for the "no changes" no-op — this was caught in review before it shipped: both `isEmptyPatch` and `undoUpdateComponent`'s two early returns had to be checked, not just the obvious one.

**The event catalog is `componentsMeta.json`'s existing hand-maintained-snapshot pattern, extended with an `events: [{id, displayName}]` array per component type**, read via `widget-meta.ts`'s new `getEventIds`/`isKnownEvent`. This is the same mechanism ticket #60's `sanitizeComponentSection` already uses for properties/styles — regenerate/extend it by hand when a widget's real `events: {...}` block (`frontend/src/AppBuilder/WidgetManager/widgets/*.js`) changes, exactly as that file's own top comment already instructs for properties.

**Actions are a curated, real subset of `frontend/.../ActionTypes.js`'s action ids** (`run-query`, `reset-query`, `abort-query`, `show-modal`, `close-modal`, `show-alert`), not the full list — each action needing its own target-existence check (`control-component`, `set-table-page`, `switch-page`, `go-to-app`, ...) is future work, not guessed at here. `event-update.helper.ts`'s `ACTION_IDS`/`validateEventPatch` is the source of truth `AgentsService.UpdateComponent` validates against; `service.ts`'s `EVENT_ACTION_IDS` zod-enum mirrors it for the tool schema only.

**UpdateQuery is its own StepType** (unlike events): it targets a query, not a component, needs its own real-id grounding (`AppInventoryService.renderQueryIndex`), and its merge is a read-merge-write against `DataQuery.options` (`query-update.helper.ts`'s `mergeQueryOptions`/`snapshotPreviousOptions`) — there is no partial-jsonb-update path, `DataQueryRepository.updateOne` replaces the whole `options` column, so the merge must happen before the write. `name`/`dataSourceId` are not part of the patch shape at all (the tool schema only ever accepts `options`), which is what keeps a query's identity and target data source untouchable by this step, rather than a runtime read-only-field check.

## Alternatives considered

- **A new `CreateEvent`/`UpdateEvent` StepType**, mirroring EE's split more literally. Rejected: it would need its own `componentId` grounding, its own dedup-on-`eventId` check, and its own undo — all identical to what UpdateComponent already has, just duplicated under a second StepType name for no behavioral difference.
- **A dynamically-derived event catalog** (parsing the frontend widget `.js` files at build/runtime, or generating componentsMeta.json's `events` from a script). Rejected for this ticket: componentsMeta.json is already a hand-maintained snapshot (ticket #60 established that pattern and its own regenerate-by-hand instruction), and per the issue's own risk-flag comment, ADR-0033 has since decided the Generation engine will build its own component/event catalog from scratch rather than extend this one — investing in a generator for a snapshot expected to be superseded is not worth it now.
- **Exposing the full `ActionTypes.js` action list.** Rejected: `control-component`, `set-table-page`, `switch-page`, `go-to-app` and the rest each need a target-existence check this ticket didn't build (a component/page/app id to validate against, the way `show-modal`'s `modal` and `run-query`'s `queryId` are). Exposing them unvalidated would let the model target a hallucinated component/page silently.

## Consequences

- `AgentsService.UpdateComponent`'s return/undo shape grew a fourth optional key (`event`), and `undoUpdateComponent` now has two independent restore paths (property/style merge, event create-or-update) that can both be present on one Artifact.
- Per the issue's own risk-flag comment: this ADR's event-catalog mechanism (componentsMeta.json's hand-maintained `events` list) is expected to be superseded once the Generation engine (ADR-0033) lands with its own catalog built from scratch. This ADR's StepType-placement decision (events on UpdateComponent, not a new StepType) is independent of that and is not expected to need revisiting.
- The curated `ACTION_IDS` subset means "make the button run this query" and "make the button open this modal" work end-to-end; "make the button switch to this page" or "make the button disable that other component" do not yet — a step whose PRD instruction needs one of those actions will fail the tool call's `actionId` enum and retry, not silently produce a wrong action.
