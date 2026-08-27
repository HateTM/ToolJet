---
status: accepted
---

# Selecting an external data source removes `CreateTable` from the plan; ToolJet DB stays the only place the AI Builder creates tables

Ticket #19 wants an explicit "Select your database" step before the AI proposes a schema, defaulting to the built-in ToolJet DB but letting the user point the plan at a data source they have already connected. That proposal collides with what `CreateTable` actually is, and #26 was split out to settle the collision before #19 is built.

`AgentsService.CreateTable` delegates straight to `TooljetDbTableOperationsService.perform(organizationId, 'create_table', tables)`. That call has no data-source parameter — not one that is ignored, one that does not exist. It always creates the table in the organization's built-in ToolJet DB, and there is no code path anywhere in this flow for issuing DDL against a connected external source. So the moment a picker can select something other than ToolJet DB, every `CreateTable` step in the plan becomes a step with nowhere to go.

Decided: when the user selects a connected external data source, the plan contains no `CreateTable` steps at all. The planner is told not to propose them, and the PRD states the constraint up front — the AI works against that source's existing schema instead. When the selection is ToolJet DB, nothing changes from today: the full create-tables-then-query cycle stands.

The constraint is expressed at planning time, not enforced at execution time. A plan that proposes a table it cannot build and then fails on it would be a worse version of the same outcome: the user has already approved something by then, and the failure arrives after the run has started. Telling the model the target upfront makes the proposal honest, and leaves the existing validate-and-retry machinery for the errors it was built for.

**Rejected: extend `CreateTable` to arbitrary data sources.** This is the option that would make the picker mean what its label implies, and it is out of reach for a reason deeper than plumbing. Threading a data source through `TooljetDbTableOperationsService` is the easy half; the hard half is that DDL capability is not uniform across connectors. Several are read-only, several are non-relational, and the ones that can create tables do not agree on what a table is. "Create a table in the selected source" is not one feature but a per-plugin matrix, and each cell of it needs its own schema translation from the columns the model proposed. Nothing about #19 justifies opening that.

**Rejected: let the selection affect queries only.** The cheapest option, and the one that produces an incoherent product: tables created in ToolJet DB while the queries meant to read them point at a different database. The generated app would be split across two stores with no relationship between them, and the picker would be actively misleading rather than merely narrow.

## What this settles elsewhere

**#14 becomes the substantive half of #19, not a follow-up to it.** Once an external source cannot receive tables, everything the selection is *for* lives in `CreateQuery` — a picker that selects a source no query can target delivers nothing at all. The two ship together or #14 ships first; #19 alone is not a shippable increment. Schema discovery for that work already exists per-connector (`listTables`, implemented in eleven plugins, reading `information_schema` in `postgresql`'s case) and should be reused rather than reinvented.

**#23 is unaffected.** Foreign keys and indexes stay a ToolJet-DB-only concern, which is now permanently where `CreateTable` lives — so that ticket's scope narrows to a place this decision has fixed rather than left moving.
