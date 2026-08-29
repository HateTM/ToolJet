# ADR-0023: Tagged resources are listed from the workspace, selected outside the prompt text, and delivered through the handoff store

Date: 2026-08-29
Ticket: #47 (datasource referencing in the prompt bar → taggedResources passed to createApp)
Status: Accepted

## Context

Production's prompt bar (the `PromptInput` module) collects datasource/table references inline inside a CodeMirror editor (`referenceTypes: ['datasources']`, `onReferencesChange`) and passes the collected `{ datasources, tables }` as `taggedResources` to `createApp`, threaded into the navigate state. The fork's `/home` prompt bar is a plain textarea with no CodeMirror wrapper (inline `@`-mentions are ticket #27, deliberately deferred as the highest-UI-risk item), so the collecting mechanism had to be re-chosen. The listing source also had to be chosen: on `/home` there is no app, hence no app version to enumerate data sources against.

## Decision

1. **Selection is a picker, not inline syntax.** A database-icon button beside the textarea opens a workspace datasource list; selected sources render as removable chips inside the prompt bar; submit collects them as `{ datasources: [...], tables: [] }` — the production shape — and passes them as the fourth `createApp` argument. The prompt text itself stays untouched.
2. **The list comes from the workspace listing** (`globalDatasourceService.getAll(organizationId)` → `GET /data-sources/:organizationId`), fetched lazily on first open. The app-scoped `datasourceService.getAll` requires an `app_version_id` and `environment_id`, neither of which exists before the app is created.
3. **Delivery rides the handoff store.** `beginHandoff` gains a `taggedResources` parameter and holds them as `handoffTaggedResources` with the prompt's lifecycle: held while the handoff is pending or failed, dropped by `finishHandoff`. Consuming them in the Generate flow (system-prompt context vs tool args) remains scoped to its own ticket.

## Alternatives considered

- **Inline `@`-mentions in the textarea (production parity).** Lost for now: it needs a CodeMirror composer (ticket #27) and is the highest-UI-risk item in the ordering. The picker delivers the same data shape, so the composer can replace it without changing anything downstream.
- **The app-scoped `datasourceService.getAll`.** Lost: it requires an app version that does not exist yet at prompt time; it would have forced a fake version or a new endpoint.
- **Passing tags only through the navigate state, not the store.** Lost: ADR-0010/0017's strip clears navigation state, so the tags would be unrecoverable after refresh — the same reasoning that moves the prompt itself into the store. They ride the exact same lifecycle.
- **Tables in v1.** Deferred: the shape carries `tables: []` for forward compatibility, but no table-listing UI ships here — table enumeration on `/home` has no settled backend surface yet.

## Consequences

- The tag chips render in both prompt-bar variants (`home` and `appsList`) — one shared component, and both entry points funnel into the same `createApp` handoff that already accepted `taggedResources`.
- `taggedResources` reaching the builder is now guaranteed for the current session's handoff; until the consuming ticket lands, the store holds them and the Generate flow ignores them.
- The picker is a hand-rolled overlay rather than the Radix dropdown used by `ExamplePromptsDropdown` in the same file: Radix's floating-ui hung under the jsdom/jest environment, and a controlled dropdown keeps the selection tests deterministic. If ticket #27's composer replaces the picker, both should consolidate on one mechanism.
