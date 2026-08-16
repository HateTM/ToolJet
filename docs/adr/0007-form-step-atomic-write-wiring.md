---
status: accepted
---

# A Form step atomically wires JSONSchema fields + an insert query + a submit event handler

A Form widget isn't useful for "creating records in its bound table" (ticket #6's acceptance criterion) just by existing — a real Form needs its fields to match the target table's columns, a query that actually writes a row, and an event wiring the Form's submit action to that query. ToolJet's real Form widget builds its fields from a `JSONSchema` string (`frontend/src/AppBuilder/WidgetManager/widgets/form.js`'s `definition.properties.JSONSchema`, evaluated as a `{{ ... }}` binding); submit-to-query wiring is a separate `EventHandler` row (`event.entity.ts`), not anything stored on the component itself.

We could expose each of these as its own AI-visible Step (a `CreateEventHandler` step type, say), letting the model wire them together explicitly the way it already wires a Table's `data` to a query's name. That would keep the "one Step, one Artifact" shape ADR-0004 established. But an insert query's column-to-value mapping and an event handler's `eventId`/`actionId`/`queryId` shape are entirely mechanical once "which table" and "which form" are known — there's no real decision left for the model to make, and every extra AI-visible step is another chance to hallucinate a wrong id/name (ticket #5 already had to add retry-validation for exactly that failure mode on Table/Query steps).

Decided: a `CreateComponent` step with `type: 'Form'` does all three as one deterministic unit once the model picks a table and a title: builds the Form's `JSONSchema` from that table's real columns (skipping the primary key, which is auto-generated), creates a `create_row` query against the same table with each column's value template-bound to the Form's own field (`{{components.<formName>.data.<column>}}`), and creates an `EventHandler` wiring the Form's `onSubmit` to that query. All three share the Form's single Step/Artifact — no new Step type, no extra model-facing surface for ids to go wrong on.

**v1 scope: create-mode only.** An edit-mode Form needs a specific existing record to bind to (e.g. a row selected elsewhere in the app), and nothing in the current Generate-conversation flow establishes that context — building it now would mean inventing a "selected record" concept with no consumer yet. Deferred until a ticket actually needs it, same as CreateTable-only (ticket #4) and Page+Table-only (ticket #5) were deliberately partial slices of ADR-0002's full allow-list rather than attempts to do everything at once.
