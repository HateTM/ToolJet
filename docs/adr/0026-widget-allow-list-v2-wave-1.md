# ADR-0026: Widget allow-list v2 — Wave 1 sourced from the EE meta snapshot, not hand-authored

Date: 2026-09-02
Ticket: plan increment 3 (`docs/plans/2026-09-02-ai-builder-expansion.md`) — full tool-parity, "all platform widgets"
Status: Accepted (Wave 1 only; Wave 2 — Tabs, Listview, IFrame, FilePicker, ModalV2, PopoverMenu, ButtonGroupV2, DropdownV2 migration, DatePickerV2, TreeSelect, Chat, Html — is out of scope for this ADR and remains unchecked in the plan)

## Context

`AgentsService.CreateComponent` (ticket #63/#60) supported 12 component types (`Page` + 11 widgets). The plan's increment 3 asks for the platform's full ~40-type catalog (`frontend/src/AppBuilder/WidgetManager/configs/widgetConfig.js`). Each new type needs three things kept in lockstep: a `createComponentTool` zod branch (`service.ts`), a typed builder in `AgentsService` that calls `createWidgetComponent`, and — the part hand-authoring would make expensive — a `componentsMeta.json` entry, since `sanitizeComponentSection` (ticket #60) silently drops any property not listed there.

`ee-extract/server-dist-ee/ai/helpers/componentsMeta.json` (present in this fork's working tree, not committed — ADR-0033's later map decided the Generation engine will stop depending on it) already carries a hand-verified meta snapshot for 56 widget types, generated from the real frontend widget configs at the time EE was extracted. Its shape is richer than this CE file's trimmed format (it embeds `properties[key].validation` and `definition.{section}[key].value` as separate blocks rather than merged).

## Decision

Wave 1 (TextArea, PasswordInput, NumberInput, Link, Divider, Icon, StarRating, Statistics, Tags, Datepicker) is added to `componentsMeta.json` by mechanically transforming the matching EE snapshot entries into this file's merged `{ value, validation }` shape, rather than hand-typing each property's schema from the frontend `widgets/*.js` files. `EmailInput`, `CurrencyInput`, `PhoneInput` have no EE equivalent (fork-only widgets); their meta entries are hand-built from the current fork's own `widgets/{emailinput,currencyinput,phoneinput}.js`, following the same shape and reusing `TextInput`'s `styles`/`others` blocks (all of ToolJet's text-input family shares one style schema).

The one-off transform script is not committed — this ADR records the method (transform script mapping EE keys to CE keys, described above) so Wave 2 can repeat it against the remaining EE-covered types (Tabs, Listview, IFrame, FilePicker, ModalV2, PopoverMenu, DropdownV2 v2 migration, DatePickerV2, TreeSelect are all present in the EE snapshot too) instead of re-deriving it.

A pre-existing mismatch between the EE snapshot and the current fork widget was found and patched by hand: `Datepicker`'s EE meta lacked `placeholder`/`showClearBtn` (added later to the fork's `datepicker.js`) — added to the CE entry to match. Colors in the ported `styles` blocks are EE's old hex values, not this fork's `var(--cc-*)` design tokens; left as-is since `componentsMeta` values are only a validation-fallback/type-inference source, never the actual value a new component is created with (that comes from each `AgentsService` builder, which does use the fork's current `var(--cc-*)` tokens).

## Alternatives considered

- **Hand-type each new type's `componentsMeta.json` entry from `frontend/src/AppBuilder/WidgetManager/widgets/*.js`.** Lost: ~13 widgets × ~10-20 properties/styles each, each needing a schema type inferred by hand — an order of magnitude more effort than transforming an already-correct snapshot, for a worse result (EE's snapshot was itself validated against real widget behavior at extraction time).
- **Skip `componentsMeta.json` for new types and let `sanitizeComponentSection` silently drop everything.** Rejected outright — the ticket #60 validator's whole point is rejecting hallucinated properties, and an empty meta entry means it rejects *real* ones too, so a new-type widget would be created with none of the properties its builder tries to set.
- **Reuse the EE `componentsMeta.json` file wholesale instead of the trimmed CE format.** Not compatible with `widget-meta.ts`'s existing `getWidgetMeta`/`getDefaultValue`/`getValidationSchema` contract, which expects the merged shape; changing that contract to accept both shapes was more churn than a one-time transform.

## Consequences

- Wave 2 should reuse this same transform (EE meta → CE trimmed shape) for every EE-covered type it needs — only fork-only types not in EE's 56 (e.g. any this fork added independently) require hand-authoring, following the `EmailInput`/`CurrencyInput`/`PhoneInput` precedent here.
- `componentsMeta.json` now has stale (EE-era) color defaults for the 10 ported Wave 1 types' `styles` sections. Harmless per the reasoning above, but a future pass could re-sync them to the fork's current `var(--cc-*)` tokens for consistency if the validator's fallback path is ever exercised in a way that surfaces them to a user.
- Per ADR-0025's closing note, this whole `componentsMeta.json` validation path is expected to be superseded once the Generation engine (ADR-0033+) lands its own component catalog — this ADR's transform trick is a bridge for the current path, not a long-term investment.
