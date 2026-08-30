# AI Builder

Chat-driven app generation for ToolJet: a user describes what they want in natural language, the assistant proposes a plan, and once approved, the plan is executed as a build against a real ToolJet `App`.

## Language

**Conversation**:
A thread of messages between one user and the assistant, scoped to one `App`. Persisted as `AiConversation`. Has a `conversationType` (see below) that fixes what kind of thread it is for its whole lifetime.
_Avoid_: Chat, session, thread

**Generate conversation**:
A `Conversation` whose purpose is building or modifying the `App` through the PRD → approve → build cycle described below. Corresponds to `conversationType: 'generate'`.

**PRD**:
"Product Requirements Document" — the assistant's structured plan for what to build, delivered as an AI message in a Generate conversation, *before* any `App` changes happen. The user can keep chatting to refine it. Nothing is built until it's approved.
_Avoid_: Plan, spec, proposal

**Approve** (a PRD):
The user action that locks in a PRD and starts execution ("Looks good, run it" in the schema `Preview`). The full ordered `Step` list is generated once — by a `Preview` if one came first, otherwise at approve time — and the plan's shape doesn't change after this point, only each Step's concrete props get filled in as execution reaches it (see [ADR-0004](docs/adr/0004-fixed-step-plan-at-approve.md)). One-way: there's no "un-approve," only rewinding executed steps.

**Preview** (a plan):
The user action that shows what a PRD would build *before* anything executes: the plan is generated (or reused) and returned as JSON, with each `CreateTable` Step carrying its **Planned table** — and, when the PRD asks for sample data, its **Planned seed rows** — the concrete definitions the executor will create and insert verbatim. Two ways forward, neither discarding the PRD: "Looks good, run it" (which becomes the `Approve`) or "I want to make changes" (drop the preview, keep chatting). Previewing twice is idempotent, and refining the PRD by chat makes any earlier preview stale (see [ADR-0020](docs/adr/0020-schema-preview-shows-the-planners-own-table-definitions.md)).
_Avoid_: Dry run, preflight, schema editor

**Planned table**:
The table definition (name, columns, foreign keys) the planner proposes for a `CreateTable` Step at plan time, persisted on the Step. What the schema `Preview` renders, and what `executeCreateTableStep` creates without a further LLM call — so the preview is always truthful. Steps without one (pre-ADR-0020 plans, malformed proposals) fall back to the per-step LLM path.
_Avoid_: SQL, DDL

**Planned seed rows**:
The sample-data rows (1–50 plain records of column → primitive value) the planner proposes alongside a **Planned table** when the PRD calls for sample or starting data (ticket #48, [ADR-0024](docs/adr/0024-seed-data-is-planner-proposed-structured-rows-on-the-create-table-step.md)). The `Preview` renders them as a table, and `executeCreateTableStep` inserts them verbatim right after creating the table — no LLM call, no SQL. Malformed rows are dropped at plan time; the per-step LLM fallback never seeds. Executed one row per query with a per-row outcome report in the run UI (ticket #62): a failed row leaves the rest standing, and only a total seed failure fails the Step.
_Avoid_: Seed query, seed SQL, bulk insert step

**Step**:
One unit of execution against the `App`, run after a PRD is approved. Each `Step` produces exactly one `Artifact`. A Step either creates a Component (v1 target types: Page, Table, Form, Button, Text, TextInput, Container), creates a ToolJet DB table, or creates a Query — against a ToolJet DB table, or against a `Queryable data source` — see [ADR-0002](docs/adr/0002-generic-component-tool.md) and [ADR-0019](docs/adr/0019-createquery-targets-connected-sql-sources-from-a-schema-it-was-shown.md).

**Artifact**:
The concrete output of one `Step` — the generated/changed piece of the `App` (e.g. a component, a table). Persisted as `Artifact`, linked to the `Conversation` and to the specific AI `Message` that produced it.
_Avoid_: Output, result, generation

**Rewind**:
Undo execution back to an earlier `Step`, discarding the `Artifact`s made after it. Applies within a single approved PRD's execution, not across PRDs.

**Phase**:
The named group (e.g. "Create data queries") the planner assigns each `Step` of a plan to. Rendered by the chat panel as a header over the consecutive run of steps sharing the label, with a per-phase resolved count; steps without a label fall into a single unnamed group. See [ADR-0021](docs/adr/0021-planner-assigned-phases-and-checkpoint-based-skip.md).
_Avoid_: Stage, milestone

**Skip** (a step):
The user's decision, during execution, that a `pending` or `running` `Step` should produce nothing: the plan continues to the next step and no `Artifact` is made. Recorded by the skip-step endpoint and acted on at the execution loop's next checkpoint — a step skipped mid-run has any outcome it just produced undone the same way `Rewind` undoes one. See [ADR-0021](docs/adr/0021-planner-assigned-phases-and-checkpoint-based-skip.md).
_Avoid_: Cancel, pause, abort

**Regenerate** (a message):
Re-run a specific AI response in place, branching off its parent message (`parentId`) rather than replaying the whole `Conversation`. Produces a sibling message; the old one is superseded (`isLatest: false`) but not deleted.
_Avoid_: Retry, redo

**Learn conversation**:
A `Conversation` scoped to Q&A about the current `App` — its structure and its `Generate conversation` history — rather than building. No PRD, no `Step`s, no `Artifact`s. Corresponds to `conversationType: 'learn'`. Answered from an `App inventory`, not from ToolJet's own product documentation — the latter is a separate, unrelated concern.
_Avoid_: Docs mode, Q&A mode, chat mode

**App inventory**:
A distilled, freshly-assembled snapshot of the current `App` — its pages, the type and name of each page's components, its data sources, and its queries — plus a condensed summary of past approved PRDs. Assembled fresh for every message in a `Learn conversation`; never indexed or persisted (see [ADR-0011](docs/adr/0011-learn-conversation-context-assembled-directly-no-rag.md)). Omits layout and styling: a `Learn conversation` answers "what does my app do," not "what is this button's border-radius."
_Avoid_: Docs, knowledge base, context

**Queryable data source**:
One data source the user has already connected that a `Step` may write a query against, together with the tables it actually contains — read through the connector's own schema introspection at plan time, never from the PRD's wording. Enumerated once per approval and shown to both the planner and each query Step, which may only name a source from that list. Limited to the SQL family, and never a place tables get created: only ToolJet DB receives a `CreateTable` (see [ADR-0018](docs/adr/0018-data-source-selection-removes-createtable-from-the-plan.md) and [ADR-0019](docs/adr/0019-createquery-targets-connected-sql-sources-from-a-schema-it-was-shown.md)).
_Avoid_: External database, connection, datasource

**Promote** (a Learn conversation):
The user action that starts a new `Generate conversation` seeded with a `Context seed` drawn from a `Learn conversation`. The originating `Learn conversation` is untouched and stays separately accessible — `conversationType` never changes on an existing `Conversation` (see [ADR-0012](docs/adr/0012-promote-creates-a-new-conversation.md)).

**Context seed**:
The condensed handoff placed into the first message of a `Generate conversation` created by `Promote` — the triggering question and its answer, not the full `Learn conversation` history.

**Fix with AI**:
The user action offered on a component property whose expression failed to resolve: the assistant reads the failing expression and its error and proposes a corrected one, which the user applies into the field in a single click. Available only where an error is already showing — it is not a general "write this code for me" affordance, and it never surfaces on a property that resolves cleanly (see [ADR-0013](docs/adr/0013-fix-with-ai-scoped-to-failing-property-expressions.md)). Unrelated to `Conversation`: it neither reads nor writes one.
_Avoid_: Copilot, autocomplete, auto-fix, quick fix

**Suggestion**:
What one `Fix with AI` request produces: a single proposed replacement expression for the failing property, plus a one-line plain-language explanation of what was wrong. Exactly one per request, generated in one shot and never persisted (see [ADR-0014](docs/adr/0014-fix-suggestion-is-one-shot-and-not-persisted.md)) — the user's only responses to it are apply, retry, or dismiss. `Regenerate` and voting do not apply to it.
_Avoid_: Fix, completion, recommendation

**Error context**:
Everything the assistant is given to produce a `Suggestion`: the failing expression, the resolver's error message, the name of the property and the component it belongs to, and the fallback value the property reverted to. Assembled on the client from what the code editor already has on hand — a `Fix with AI` request carries no `App inventory` and no conversation history, because the failing expression and its error are what make the answer determinable.
_Avoid_: Error payload, error data, prompt context

**Copilot**:
The user action offered inside a query editor: the user describes in words what the query body should do and the assistant writes it. Explicitly requested from a button in the editor's overlay controls — never triggered by typing, and never offered outside the query editors (see [ADR-0015](docs/adr/0015-copilot-is-a-prompt-button-in-query-editors.md)). The counterpart to `Fix with AI`, not a variant of it: `Copilot` writes code that does not exist yet, `Fix with AI` repairs one expression that broke. Unrelated to `Conversation`: it neither reads nor writes one.
_Avoid_: Autocomplete, ghost text, inline suggestions, assistant

**Completion**:
What one `Copilot` request produces: the complete replacement body for the editor, plus a one-line plain-language note on what the code does. Exactly one per request, generated in one shot and never persisted — the user's only responses to it are apply, retry, or dismiss. Applied by overwriting the whole editor body, after being shown verbatim in the popover first (see [ADR-0016](docs/adr/0016-copilot-completion-replaces-the-editor-body-and-reuses-app-inventory.md)). `Regenerate` and voting do not apply to it.
_Avoid_: Suggestion, recommendation, snippet, draft

**Copilot context**:
Everything the assistant is given to produce a `Completion`: the user's prompt, the editor's current code, its language, the kind of data source the query runs against, and the `App inventory` of the App being edited. The inventory is what keeps a `Completion` from inventing query and component names — the deliberate difference from an `Error context`, which carries none (see [ADR-0016](docs/adr/0016-copilot-completion-replaces-the-editor-body-and-reuses-app-inventory.md)).
_Avoid_: Prompt context, copilot payload

**Tagged resource**:
A datasource (later, a table) the user explicitly attaches to the homepage prompt bar while composing their prompt, passed as `taggedResources: { datasources, tables }` through the create-app handoff (`state: { prompt, taggedResources }`) into the builder store's handoff alongside the `handoffPrompt` (ticket #47). Deliberately separate from the prompt text — selection happens outside it via a picker, not inline mentions — and from a `Queryable data source`: a tagged resource is a user-stated intent carried into the builder, not a planner-verified query target. What the Generate flow does with it (system-prompt context vs tool args) is scoped to its own ticket.
_Avoid_: Mention, reference, attachment
