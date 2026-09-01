# ADR-0037: Component triggers and event actions are two separate vocabularies

Date: 2026-09-01
Ticket: #92 (Generation engine: component and event catalogs)
Status: Accepted

## Context

ADR-0033 calls for a component catalog and an event catalog, modeled on the EE reference's
`TooljetComponentData`/`TooljetEvents` split, built from scratch (not migrated from the fork's
`componentsMeta.json` or the single hardcoded event in `agents.service.ts`).

An event handler needs two independent pieces of vocabulary:

1. **A trigger** — which component-raised occurrence starts the handler (`onClick`, `onSubmit`,
   `onRowClicked`, ...). Triggers are per component: `Table` raises `onRowClicked`, `Form` raises
   `onSubmit`, and `Table` cannot raise `onSubmit`. This is declared per widget in
   `frontend/src/AppBuilder/WidgetManager/widgets/*.js`'s `events: {}` block.
2. **An action** — what the handler does (`run-query`, `show-alert`, `open-webpage`, ...). Actions
   are global: any trigger on any component can run any action. This is declared in
   `frontend/src/AppBuilder/RightSideBar/Inspector/ActionTypes.js`.

Two id vocabularies exist for actions in this codebase, and they disagree:

- `frontend/src/AppBuilder/_stores/constants/actions.js`'s `ACTIONS` — camelCase
  (`runQuery`, `showAlert`, `scrollComponentInToView`), used for the JS-expression-editor code-hint
  list.
- `frontend/src/AppBuilder/RightSideBar/Inspector/ActionTypes.js`'s `ActionTypes` — kebab-case
  (`run-query`, `show-alert`, `scroll-component-into-view`), plus entries `ACTIONS` lacks
  (`abort-query`, `control-component`, `set-table-page`).

`server/src/modules/ai/services/agents.service.ts`'s only current event-generation call —
`eventsService.createEvent({ event: { eventId: 'onSubmit', actionId: 'run-query', ... } })` —
confirms which one is real: `event_handler.entity.ts` persists the kebab-case id as `actionId`.
`ACTIONS` is a code-hint list for a different feature entirely and was never a candidate.

## Decision

- The event catalog holds **actions only**, keyed by the kebab-case id `ActionTypes.js`/
  `event_handler` actually use — `EVENT_CATALOG['run-query']`, not `EVENT_CATALOG['runQuery']`.
- **Triggers live inside each component catalog entry**, not in a separate global list, because
  they are not global: `ComponentCatalogEntry.triggers` is the per-component vocabulary, sourced
  from that widget's `events: {}` block.
- `isValidTrigger(componentName, triggerId)` takes both arguments for this reason — a trigger id
  alone is not meaningful without knowing which component it's being checked against.

## Consequences

- A future event-generation stage validates a proposed event handler in two independent lookups:
  `isValidTrigger(componentName, eventId)` against the component catalog, then
  `isValidEventAction(actionId)` against the event catalog — not one combined lookup.
- `frontend/src/AppBuilder/_stores/constants/actions.js`'s `ACTIONS` list stays out of scope for
  the Generation engine entirely; it is a frontend code-hint concern, not a generation concern.
- If a widget gains or loses a trigger, only that component's catalog entry needs updating — the
  event (action) catalog is unaffected.
