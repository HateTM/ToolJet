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
- **Slot-qualified parents are out of scope** for `Tabs` and `Listview`. ToolJet's `parent` field is not always a bare component id: `Tabs` children key it as `${parentId}-${tab}` (confirmed from `frontend/src/AppBuilder/AppCanvas/appCanvasUtils.js:396-410`'s `getParentComponentIdByType`, the same source both CE and EE share — this is app-builder canvas logic, not EE-private), and `Listview`'s items use their own fixed subcontainer id, a different mechanism again. Neither is addressable with a bare `parentComponentId: string`: `Tabs` would need a tab index/id field and its own layout math (a pane's internal grid is not the same coordinate space `generate-layout.ts` computes for page-level and Container/Form children); `Listview`'s items are a different addressing scheme entirely. Both are therefore explicitly rejected as `parentComponentId` targets — by the type check, and by the system prompt telling the model not to reference them — until a follow-up pass adds their own slot addressing.

### Follow-up (same day): `ModalV2` header/footer/body slots

Unlike `Tabs`/`Listview`, `ModalV2`'s three slots turned out to fit the existing bare-string `parentComponentId` shape without a new field: the canvas already renders each slot under a fixed, literal sub-container id — the modal's own id for the body (`frontend/src/AppBuilder/Widgets/ModalV2/Components/Modal.jsx`'s `<SubContainer id={id}>`), `${id}-header` and `${id}-footer` for the other two (`Header.jsx`/`Footer.jsx`). No tab index or per-item key is involved, so the same "resolve `parentComponentId` against `context.priorResults`, reject anything hallucinated or wrong-type" grounding pattern used for Container/Form extends cleanly: `executeComponentStep` strips a trailing `-header`/`-footer` suffix, resolves the base id, and requires it to be a `ModalV2` (suffixed) or a `Container`/`Form`/`ModalV2` (unsuffixed, body slot) created earlier in the same plan on the same page.

Two things specific to slots, not needed for Container/Form:

- **Height clamp.** Container/Form's own default footprint (450px) already comfortably fits a typical child's default size. ModalV2's header/footer are a ~56px strip — a widget's stock default height (e.g. Table's 460) would blow it out. `createWidgetComponent` (`agents.service.ts`) clamps a slot child's desired height to 30 grid units when `parentId` ends in `-header`/`-footer`, before it ever reaches `generateComponentLayout` (which has no notion of the parent's own size). The body slot is not clamped — its available height is comparable to Container/Form's.
- **Visibility.** `showHeader`/`showFooter` already default `true` on the widget itself (`modalV2.js`), so a slot child created via `parentComponentId` is visible without `createModalV2Component` needing to override anything — verified rather than assumed, since a modal is created in an earlier step than any child that later targets its footer.

`Tabs` and `Listview` remain rejected, and `updateComponentTool` remains untouched (same reparenting-scope reasoning as the original decision above) — this follow-up only narrows the ModalV2 case, it doesn't revisit the rest.

### Follow-up 2: Tabs pane nesting, and Listview turned out to need no new mechanism at all

`Listview`'s rejection above was overcautious: its `defaultChildren` (`listview.js`) carry no `slotName` and no `tab`, so `getParentComponentIdByType` already falls through to its `return parentId` default — a Listview's row template is addressed by the **bare** widget id, exactly like a Container's body. There is no separate "item" addressing scheme to build; `parentComponentId: <listviewId>` was always going to work once the type check allowed it. It's added to the bare-id-allowed set alongside Container/Form/ModalV2 with no other code change.

`Tabs` is a real slot-qualified case, but a data-driven one rather than a literal-suffix one like ModalV2's `-header`/`-footer`: a pane's parent id is `${tabsId}-${tabId}` (`appCanvasUtils.js`'s `getParentComponentIdByType`), and `tabId` is always the tab's **array index as a string** — `createTabsComponent`'s own `tabsLiteral` assigns `id: '${index}'` regardless of the (customizable) tab titles, so pane addressing is `<tabsId>-<tabIndex>` (0-based), not tied to any title the model chose. Because the tab *count* is per-instance (a plan can create a 2-tab bar and a 5-tab bar on the same page), `createTabsComponent` now returns `tabsCount` on its artifact content, and `executeComponentStep` validates a Tabs suffix against that specific instance's count — not an assumed default of 3.

This also required moving off ModalV2's original regex-based suffix split (`/^(.+)-(header|footer)$/`): every component id here is a UUID already full of dashes, and a literal `-header`/`-footer` suffix regex is unambiguous only because those two words can't appear elsewhere. A `-<tabIndex>` suffix has no such fixed shape to regex for. The validation now tries an exact (bare) id match against this plan's prior `CreateComponent` results first, and only then looks for a prior artifact whose id `rawParentId` extends by exactly `-<suffix>` — avoiding blind dash-splitting of a UUID. A bare Tabs id (no suffix) is explicitly rejected: unlike Container/Form/Listview/ModalV2's body, a Tabs bar has no "default" pane to fall back to.

`updateComponentTool` reparenting remains out of scope, same reasoning as before.

### Follow-up 3: reparenting an existing component — as its own `MoveComponent` step, not through `updateComponentTool`

The plan asked for "reparenting through `updateComponentTool`". That's not just a scope decision to narrow — it isn't expressible there at all: `UpdateComponent`'s patch only ever touches the `properties`/`styles` sections through `ComponentsService.update`'s `_.mergeWith` (ADR-0025); `parent` is a sibling top-level field, never part of either section, and folding it in would mean reaching around the merge ADR-0025 deliberately fenced off.

What DOES already exist, and is exactly what reparenting needs, is `ComponentsService.componentLayoutChange` — the same API `createWidgetComponent`'s own sibling-compaction pass calls for pure-layout diffs. It writes a component's `parent` directly, and — this mattered more than expected — it already runs `assertNoParentCycle` (a real, transaction-locked, server-side cycle guard) before any write commits. Create-time nesting never needed this (a brand-new child has no descendants to loop back through), but an existing component can, so this guard is precisely the piece create-time nesting got to skip and reparenting can't.

This is implemented as a new `StepType`, `MoveComponent` — its own tool (`moveComponentTool`: `componentId`, optional `newParentComponentId`), its own execution method (`executeMoveComponentStep`, grounding both ids against the live `renderComponentIndex` the same way `UpdateComponent`/`DeleteComponent` do — unlike create-time `parentComponentId`, both the moved component and its new parent can be anything already in the app, not just this plan's own `priorResults`), and its own `AgentsService.MoveComponent`/`undoMoveComponent`. Scope is narrowed the same way ModalV2/Tabs were for create-time nesting: only a bare Container/Form/Listview id is a valid `newParentComponentId` for Move — ModalV2 header/footer and Tabs panes stay create-time-only (`parentComponentId` on `CreateComponent`), since validating a *pre-existing* app component's slot legitimacy (e.g. a live Tabs bar's real tab count) from the live inventory has no equivalent to the `tabsCount` this plan's own artifacts carry.

`MoveComponent`'s undo, matching the lifecycle contract from this ADR's original decision, snapshots exactly what it overwrites — the moved component's own previous `parent` and `layouts.desktop` — and nothing else. Deliberately not snapshotted or restored: the old parent's remaining children (Move leaves the same gap `DeleteComponent` already leaves today, never treated as a defect there) and the new parent's sibling compaction (not undone, same as a freshly `CreateComponent`-ed widget's own compaction isn't undone either). This keeps Move's undo surface exactly as wide as Update/Delete's — one component's own state — not wider.

## Alternatives considered

- **A single `parentComponentId: string` covering every container type, slot-qualification left to the caller.** Rejected: the model would have to construct `${id}-${tab}` strings itself with no grounding for `tab`/slot names, defeating the whole point of validating against `context.priorResults` — a wrong tab index fails silently (ToolJet renders nothing for an unknown pane) rather than the loud retryable failures this lifecycle otherwise guarantees.
- **Folding reparenting into `updateComponentTool` now, while nesting is fresh in scope.** Rejected for the reason above — it's a different, larger undo/layout problem than sparse-key merge, better decided on its own once there's a real use case forcing the shape.
- **A generic Container-internal grid width derived from the container's own pixel width.** Not needed: ToolJet's grid is relative-unit (count-based), not pixel-based, so `generate-layout.ts`'s existing `GRID`/`clampSizeToGrid` constants apply unchanged inside a Container/Form's coordinate space — no new layout constants were required for this pass.

## Consequences

- An AI-authored PRD can now produce a Form, Container or ModalV2 with real fields/content nested inside it (e.g. "a form with a name and email field", or "a modal with a Save button in its footer") instead of rendering empty with its fields scattered as page-level siblings.
- Tabs and Listview still render empty when the PRD wants content inside them — narrowed from "no container type supports nesting" to "only these two still don't."
- A future Tabs/Listview slot-nesting pass has a concrete, cited target shape to implement against (`getParentComponentIdByType`'s remaining cases) rather than needing to re-derive it from the frontend.
