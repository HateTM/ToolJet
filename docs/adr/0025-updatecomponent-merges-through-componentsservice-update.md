# ADR-0025: UpdateComponent merges through ComponentsService.update, not a hand-rolled deep merge

Date: 2026-09-01
Ticket: #66 (UpdateComponent — diff patches and merge of existing components)
Status: Accepted

## Context

Ticket #66 ports the EE `updateComponent`/`updateSingleComponent` idea: the LLM returns a sparse patch — only the properties/styles paths that actually changed — which must land on an existing component without disturbing anything the patch didn't mention, then be undoable by a compensating rewind (ADR-0008). Two real options existed for where the merge itself happens.

## Decision

`AgentsService.UpdateComponent` never reads the component's full current properties/styles to build a merged object. It sanitizes only the patch's own keys against componentsMeta (ticket #60's `sanitizeComponentSection`, the same validator `CreateComponent`'s widgets already go through) and hands that sparse, sanitized diff straight to `ComponentsService.update`, which already deep-merges an incoming `component.definition` onto the stored row via `_.mergeWith` (`component.service.ts`'s `updateComponents`). The merge is therefore performed exactly once, in the one place the rest of the app builder already trusts it.

The compensating-undo snapshot (`component-update.helper.ts`'s `snapshotPreviousSection`) captures, from the component's current state, only the pre-patch value of each key the patch is about to touch — and only when the component already had a value for that key. `undoUpdateComponent` restores that snapshot through the identical `ComponentsService.update` merge path.

## Alternatives considered

- **Hand-rolled deep merge in `AgentsService`, writing the full merged properties/styles object.** Lost: it would duplicate `updateComponents`' `_.mergeWith` special-casing per widget type (Table/Form array handling, `DropdownV2`/`Tabs`/etc. array-vs-object normalization — see `component.service.ts`), and the two merges would drift the first time either one is touched for an unrelated widget.
- **Fetching and re-emitting the component's full properties/styles as the "patch."** Lost: it defeats the diff contract the issue asks for (LLM told to "return ONLY the paths that were modified") and reintroduces the exact hazard sparse patches avoid — a stale or hallucinated value for an untouched property silently overwriting the real one.
- **Snapshotting a `null` for a key the component had no prior value for, so undo could "unset" it.** Lost: `ComponentsService.update`'s merge cannot express deletion — writing back `null` leaves the key present with a null value, which is a worse rewind than leaving a newly-introduced key alone. Documented instead as a known gap (see `component-update.helper.ts`'s doc comment and `undoUpdateComponent`'s).

## Consequences

- UpdateComponent's validation is exactly ticket #60's existing validator applied to a smaller input — no second schema-validation path to keep in sync.
- Undo of an UpdateComponent step is a full compensating merge for every property/style the step actually changed, with one known gap: a patch that *introduced* a property/style the component had no prior value for cannot be fully un-introduced by rewind (the key stays, at its patched value). Flagged in code and in the ticket's PR, not silently accepted.
- `AppInventoryService.renderComponentIndex` (new) is the single source both the step planner and UpdateComponent's own execution-time context use to ground a real component id — mirroring how `CreateComponent`'s `pageId`/`queryName` are grounded in `context.priorResults`, so a hallucinated `componentId` fails the same retryable way a hallucinated `pageId` does.
- Per the risk-flag comment on issue #66: ADR-0033 (from the #79 map) has since decided the Generation engine will build its own component catalog rather than reuse `componentsMeta.json`. This ADR's merge-path decision (delegating to `ComponentsService.update`) is independent of that and still holds; only the *validator* this ticket calls (`sanitizeComponentSection` / `componentsMeta.json`) is expected to be superseded when the engine lands.
