# ADR-0043: Component diff-merge lifecycle, and create-time-only nesting

Date: 2026-09-02
Ticket: plan increment 4 (Update/Delete/Layout/Styles)
Status: Accepted

## Context

Increment 4 of `docs/plans/2026-09-02-ai-builder-expansion.md` gives the AI Builder a full component lifecycle — Create, sparse Update, Delete, and nesting/layout — instead of only ever appending flat, top-level widgets. Update (ADR-0025, ticket #66) and Delete (ticket, commit `797099f69f`) already shipped in earlier passes of this increment. This ADR records the lifecycle shape those two share, and the nesting model decided for this pass: create-time nesting into `Container`/`Form` only, everything else deferred.

## Decision — lifecycle (Update/Delete)

Every mutating step (`UpdateComponent`, `DeleteComponent`, `DeleteQuery`) follows the same three-part shape:

1. **Ground the target against reality before calling the model**, via `AppInventoryService.renderComponentIndex` — the same rendered text index feeds both the LLM's context and the post-hoc validation of whatever id it returns (`service.ts`'s `if (!componentIndex.includes(...))` checks). A hallucinated id fails loud and retryable, the same way a hallucinated `pageId` on `CreateComponent` does (see below) — never a silent no-op or a wrong-target mutation.
2. **The mutation is a sparse diff, not a full replace.** `UpdateComponent` merges only the patched properties/styles keys through `ComponentsService.update`'s existing `_.mergeWith` (ADR-0025). Delete removes exactly the addressed row.
3. **Every mutation snapshots what it overwrote, keyed to the step's Artifact, so `undoArtifact` can compensate.** `UpdateComponent` via `component-update.helper.ts`'s `snapshotPreviousSection`; `DeleteComponent`/`DeleteQuery` via a full pre-delete snapshot (component + layouts + events / query row) restored by `undoDeleteComponent`/`undoDeleteQuery`.

This is the contract any future mutating step type (e.g. a real `UpdateEvent`, if the existing `GenerateEvent` upsert ever stops being sufficient) should follow.

## Decision — nesting (this pass): create-time only, Container/Form only

`createComponentTool`'s create-time nesting reuses the same grounding pattern as (1) above, applied to a new optional field:

- Every widget type except `Page` accepts an optional `parentComponentId`. `createWidgetComponent` (`agents.service.ts`) threads it through as `parentId`, writes it to the created component's `parent` (previously hardcoded to `null`), and scopes the sibling-layout-compaction pass to `rect.parent === parentId` instead of `!rect.parent` — a nested child is placed and compacted purely within its own parent's coordinate space, invisible to and unaffected by page-level siblings (and vice versa).
- `executeComponentStep` validates `parentComponentId` the same way `pageId` is validated: it must resolve to a `CreateComponent` artifact earlier in *this* plan, on the *same* `pageId`, and — the one extra check nesting needs — of type `Container` or `Form`. Anything else (a hallucinated id, or a real id of the wrong type) is a retryable error, never a silent top-level placement or a crash.
- `updateComponentTool` is **not** touched — an existing component's `parentComponentId` cannot be changed via Update in this pass. Ticket #66 already deliberately left layout out of Update's patch surface (ADR-0025's decision to keep Update strictly additive-merge); folding reparenting into Update would both drag layout into a tool that currently never touches it and double the undo surface (old parent's siblings need re-compaction, not just the moved component's own layout). Reparenting, if wanted later, is its own ADR-worthy decision, not a corollary of this one.
- **Slot-qualified parents are out of scope.** ToolJet's `parent` field is not always a bare component id: `Tabs` children key it as `${parentId}-${tab}`, and `ModalV2` header/footer slots as `${parentId}-header`/`${parentId}-footer` (confirmed from `frontend/src/AppBuilder/AppCanvas/appCanvasUtils.js:396-410`'s `getParentComponentIdByType`, the same source both CE and EE share — this is app-builder canvas logic, not EE-private). `Listview`'s items use their own fixed subcontainer id, a different mechanism again. None of these are addressable with a bare `parentComponentId: string`; each would need its own slot-selection field (a tab index/id, or a header/footer literal) and its own layout math (a Tabs pane's or a Listview item's internal grid is not the same coordinate space `generate-layout.ts` computes for page-level and Container/Form children). `Tabs`/`Listview`/`ModalV2` are therefore explicitly rejected as `parentComponentId` targets — by the type check above, and by the system prompt telling the model not to reference them — until a follow-up pass adds slot addressing.

## Alternatives considered

- **A single `parentComponentId: string` covering every container type, slot-qualification left to the caller.** Rejected: the model would have to construct `${id}-${tab}` strings itself with no grounding for `tab`/slot names, defeating the whole point of validating against `context.priorResults` — a wrong tab index fails silently (ToolJet renders nothing for an unknown pane) rather than the loud retryable failures this lifecycle otherwise guarantees.
- **Folding reparenting into `updateComponentTool` now, while nesting is fresh in scope.** Rejected for the reason above — it's a different, larger undo/layout problem than sparse-key merge, better decided on its own once there's a real use case forcing the shape.
- **A generic Container-internal grid width derived from the container's own pixel width.** Not needed: ToolJet's grid is relative-unit (count-based), not pixel-based, so `generate-layout.ts`'s existing `GRID`/`clampSizeToGrid` constants apply unchanged inside a Container/Form's coordinate space — no new layout constants were required for this pass.

## Consequences

- An AI-authored PRD can now produce a Form or Container with real fields/content nested inside it (e.g. "a form with a name and email field") instead of the form/container rendering empty with its fields scattered as page-level siblings.
- Tabs, Listview and ModalV2 still render empty when the PRD wants content inside them — same limitation as before this pass, now narrowed from "no container type supports nesting" to "only these three still don't."
- A future slot-nesting pass has a concrete, cited target shape to implement against (`getParentComponentIdByType`'s three cases) rather than needing to re-derive it from the frontend.
- Increment 4's remaining plan items are the slot-nesting follow-up itself, and whatever it turns out to need in `updateComponentTool`.
