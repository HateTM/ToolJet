---
status: accepted
---

# `CreateQuery` may target a connected SQL data source, and only one whose schema it was actually shown

v1 restricted `CreateQuery` to the built-in ToolJet DB — an explicit scope cut, not a dead end (#14). ADR-0018 settled the half of this that had to be settled first: an external source can never receive a `CreateTable`, so everything a data-source selection is *for* lives in `CreateQuery`. This is that work.

Decided: a `CreateQuery` step may target either ToolJet DB (unchanged, and still the default) or one already-connected external data source from the SQL family — `postgresql`, `mysql`, `mariadb`, `mssql`, `oracledb`. The tool the model calls is a discriminated union on `source`, so the two branches cannot be mixed: a `tooljetdb` query carries a table id and produces `list_rows` options, a `sql` query carries a data source id and one SELECT statement and produces `{ mode: 'sql', query }`. `AgentsService.CreateQuery` gained an optional `dataSourceId` and looks up ToolJet DB only when none is given, so every existing caller — the Form step's insert query included — is untouched.

The SQL family is the whole scope for a reason that is not arbitrary: all five take a query as a single `{ mode: 'sql', query }` string, so one prompt, one tool schema and one validation path cover every one of them. A REST source takes a method, a URL, headers and a body; a document store takes something else again. Each of those is its own prompt and its own failure modes, which is a separate ticket rather than another entry in a list.

## The model may only name a source whose tables it was shown

Before the plan is generated, the connected SQL sources are enumerated and each one's tables are read through the connector's own `listTables` — the same call the query editor's table picker makes, reaching `information_schema` in Postgres' case. A source is offered to the model only if that read succeeded *and* returned at least one table. The resulting list goes into both the planner's prompt and every `CreateQuery` step's prompt, and a `data_source_id` that isn't in it is rejected with the list of what was actually on offer, the same retryable guard `pageId` and `queryName` already get in `executeComponentStep`.

Which sources are enumerated is decided by `allGlobalDS`, the permission-filtered listing the data source panel and the query editor's own picker already use, rather than by a lookup written for this feature. That list ends up verbatim in a prompt and then in queries built against real credentials, so "which sources may this user see" has to be answered by the code that answers it everywhere else. A second rule, however carefully written, is a rule that can drift from the first one. Only organization-scoped sources are considered; app-scoped (`local`) ones are a separate lookup with their own permission story, and nothing in #14 asks for them.

Table names are kept schema-qualified — `sales.orders`, not `orders` — whenever the connector reports a schema, which is valid in every dialect here. An unqualified name is ambiguous the moment two schemas both hold an `orders`, and an ambiguous name produces exactly the invisible failure that reading the real schema exists to prevent. For the same reason Postgres is asked for every schema rather than its `public` default, which would otherwise report a source with tables elsewhere as empty and silently drop it.

The list is bounded — at most ten sources, at most fifty tables each — because it rides in the prompt alongside the PRD on every planning call and every query step. The source cap counts what survived introspection, not what was found, so a row of unreachable sources cannot hide a readable one behind them.

Introspecting at plan time rather than skipping it is the load-bearing decision here. This flow *creates* queries; it never runs one. So a query written against a table that does not exist is stored successfully, the step reports success, the build reports success, and the user finds out when they open the app. There is no later stage that would catch it — which means the only place the schema can do any good is before the SQL is written. Table names in the PRD are the user's words for their data, not necessarily their database's.

For the same reason there is deliberately **no** validation of what the SQL *means* beyond the source it names. The honest way to check that is to run it, and running model-written SQL against a user's production database as a side effect of approving a PRD is not something to introduce quietly. Showing the model the real tables is the cheaper guard and it addresses the failure that actually happens.

What the statement *is*, as opposed to what it means, is checked: it must be a single statement, it must open with `SELECT` or `WITH`, and it must not contain a write keyword anywhere. That check needs nothing run. It exists because the failure it prevents is not a broken app but a destructive one — a `DELETE` or a `DROP` stored as a query sits in the app until someone presses Run, and by then it is their data. `SELECT … FOR UPDATE` is refused by the same rule, which is the intended reading: a query written to feed a Table widget has no business taking row locks.

## Assembly never fails the build

Every plan that could be built before this ticket targets ToolJet DB. So a failure to assemble the inventory — the data source lookup erroring, one connector being unreachable, a plugin having no `listTables` at all — is logged and degrades to "nothing external connected". It never propagates. A build that never needed an external source must not start failing because of a lookup added for the ones that do.

That is also why `mariadb` is in the list of kinds despite its plugin having no service-level `listTables` today: it is dropped by the same path that drops an unreachable source, costing one caught error, and it starts working the day that method is added with no change here. Sample data sources are excluded outright — they are ToolJet's own demo data, not something the user connected, and nothing should propose building an app against them.

The inventory is assembled once per approval and carried on the step-execution context, not re-read per step: each read opens a real connection to each source, and the answer cannot change while a plan is being executed.

**Rejected: let the model name tables from the PRD and skip introspection.** Cheapest by a wide margin, and it fails invisibly — see above. The cost it saves is one connection per connected source per approval.

**Rejected: cover every connector kind, not just SQL.** This is the option that would make the feature read as complete, and it is a matrix, not a feature — the same reason ADR-0018 rejected extending `CreateTable`. Each non-SQL kind needs its own request shape in the tool schema, its own prompt, and its own notion of what "read some data" means.

## What this leaves for #19

The selection is currently the model's, made from the PRD against the sources it is shown, and biased toward ToolJet DB by the prompt. #19's picker replaces that inference with the user's explicit choice; the machinery it needs — the enumerated sources, the per-source tables, the tool branch, the guard — is all here. What #19 adds is a way to say "this one, not that one" before the plan is written, and the planner instruction ADR-0018 requires becomes unconditional once a source has actually been chosen rather than merely offered.

One half of ADR-0018 is therefore deliberately still unmet: "the PRD states the constraint up front". The PRD is written before any source is selected — selection is what #19 introduces — so there is nothing yet for that prompt to state. The constraint is enforced at planning time instead, where the sources are known, and moves up to the PRD prompt with #19.

`AiService.approvePrd` now takes the acting `User` and their `UserPermissions` rather than just an organization id: resolving a data source's options goes through the same path a real query run does, and deciding which sources that user may be shown goes through the same path the data source panel does.
