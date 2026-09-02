# ADR-0045: CreateQuery's `plugin` branch — operation dropdown, derived queryable-ness, no per-plugin schema

Date: 2026-09-02
Ticket: plan increment 5 (REST/plugin queries), `source: "plugin"`
Status: Accepted

## Context

Increment 5 shipped `source: "restapi"` for `CreateQuery` and explicitly deferred `source: "plugin"`, on the stated grounds that "manifest-driven validation has nothing to collect it against" — pointing at `server/data-migrations/1784790000000-BackfillAiPluginManifestType.ts` as a possible starting point.

That premise turned out to be false, and the migration was a red herring: it only reclassifies a marketplace category label (`api` → `ai`) on `Plugin.manifestFile`, unrelated to query option schemas. The actual schema exists and is already loaded: `plugins/packages/<kind>/lib/operations.json`, governed by `operations.schema.json`, stored per-plugin as `Plugin.operationsFile` (a `File` row) and already joined + base64-decoded + JSON-parsed by `DataSourcesRepository.allGlobalDS` — the exact call `DataSourceInventoryService.listQueryableSources` already makes for the SQL/REST branches. No new loader, no new join, no new query was needed.

## Decision — queryable-ness is derived per-source, never a hardcoded kind list

Unlike `SQL_QUERYABLE_KINDS`/`REST_QUERYABLE_KINDS`, there is no `PLUGIN_QUERYABLE_KINDS` constant. A non-SQL, non-REST source is offered to the model only if its plugin's `operations.json` exposes `properties.operation.list` as a non-empty array of `{ name, value }` entries — `isPluginOperationList` in `data-source-inventory.service.ts`. Checked against several installed plugins:

- **Fits the shape** (offered): Slack, Airtable, Baserow, Google Sheets, Mailgun — each has a flat `operation` dropdown (`send_message`, `list_records`, `create_row`, ...).
- **Doesn't fit** (silently excluded, same as an unreadable SQL schema): Notion (a `resource`/`database`/`page`/`block`/`user` tree, no single `operation` dropdown), Stripe (`spec_url`-driven OpenAPI operations, not a static list).

A hardcoded kind list would drift the moment a new marketplace plugin is installed, or silently start lying the moment an existing one's manifest shape changes. Deriving from the manifest itself can't drift — it either has an operation dropdown to ground a tool call in, or it doesn't.

## Decision — option shape: flat, unwrapped, per-operation, unvalidated fields

`buildPluginQueryProps` (`service.ts`) validates only the `operation` value against the resolved source's real operations list (retryable if it doesn't match, same shape as every other hallucinated-id check in this file). It does **not** validate the per-operation field keys (`channel`, `message`, ...): `operations.json`'s per-operation properties are UI descriptors (`codehinter`, `label`, `placeholder`) for the query editor's form, not a value schema — there is no `required` marker to enforce, and inventing one would mean guessing at a contract the manifest doesn't state. The model infers which fields an operation needs from its name/description in the prompt (e.g. "send_message" implies a `channel` and a `message`) and the PRD, the same way it already infers a REST body's shape from context.

The resulting `options` object is `{ operation, ...fields }` — flat key/value pairs, no `.value` wrapping — confirmed against both Slack's and the REST API plugin's own `run(sourceOptions, queryOptions, ...)`: both read `queryOptions.<key>` directly. This is the same convention `buildRestApiQueryProps` (ADR from increment 5's restapi pass) already established; `plugin` doesn't introduce a second option-shape convention, it reuses the first one with a variable key set instead of a fixed one.

## Decision — reuses `resolveExternalDataSource`, and therefore ADR-0044's `select_datasource` interrupt, for free

`buildPluginQueryProps` resolves `data_source_id` through the same `resolveExternalDataSource` the sql/restapi branches use — an omitted id with more than one connected source (now counting SQL, REST, and plugin sources together) raises the same `select_datasource` `Interrupt` ADR-0044 already built, not a new pause mechanism. An id that's given but doesn't match a connected source stays a plain retryable model error, unchanged.

## Consequences

- `renderConnectedDataSources` gains a third rendering branch: a plugin source lists its `operations` (comma-separated values) instead of tables or "give a request path". `CREATE_QUERY_SYSTEM_PROMPT` gains one line describing the `plugin` branch, mirroring the `restapi` line's shape.
- `QueryableDataSource` gains an optional `operations` field, set only for plugin-kind sources.
- Verified unaffected, same as the restapi pass verified for itself: the SQL read-only gate (`isSingleReadOnlyStatement`/`validateMergedQueryOptions`) is conditioned on `mode === 'sql'`, which plugin options never have; `resolveCreateTableTarget` only treats a `postgresql`-kind id as an external CreateTable target, and no plugin kind is `postgresql`. Widening the inventory to include plugin sources does not widen either gate.
- The library prompts for restapi/plugin (`generateQuery` in the ported EE prompt library) remain un-ported, as increment 5 already decided — the `plugin` branch's prompt is fork-specific by the same reasoning already applied to `restapi`.
