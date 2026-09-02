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
One unit of execution against the `App`, run after a PRD is approved. Each `Step` produces exactly one `Artifact`. A Step either creates a Component (v1 target types: Page, Table, Form, Button, Text, TextInput, Container), updates an existing Component (see **UpdateComponent** below), creates a table — in ToolJet DB, or in a connected `postgresql` `Queryable data source` behind an `External write confirmation` — or creates a Query — against a ToolJet DB table, or against a `Queryable data source` — see [ADR-0002](docs/adr/0002-generic-component-tool.md) and [ADR-0019](docs/adr/0019-createquery-targets-connected-sql-sources-from-a-schema-it-was-shown.md), and [ADR-0042](docs/adr/0042-createtable-may-target-a-connected-postgresql-source-behind-confirmation.md).

**UpdateComponent** (a Step type):
Changes an existing Component already in the App — its properties and/or styles — without recreating it (ticket #66). The model returns a sparse patch (only the paths that actually changed; `{}` means no change needed), which is validated against `componentsMeta` the same way a newly created widget's properties are (ticket #60), then merged onto the Component's stored definition by `ComponentsService.update`'s own deep merge — never a hand-rolled one (see [ADR-0042](docs/adr/0025-updatecomponent-merges-through-componentsservice-update.md)). Its `Artifact` carries a snapshot of the pre-patch value of every key the patch touched, so `Rewind` can restore them; a patch that introduces a property/style the Component had no prior value for is a documented gap — rewind cannot fully un-introduce it. Targeting a Component that doesn't exist is a retryable error, never a silent clone.
_Avoid_: Edit component, patch component, diff-merge step

**Feature plan**:
The Generation engine's internal, topological ordering of the tables an LLD proposes — produced by the engine's feature-planner stage so per-entity generation creates dependencies before their dependents (see [ADR-0028](docs/adr/0028-generation-engine-pipeline-stages.md)). Distinct from the `Step` list (see [ADR-0040](docs/adr/0040-feature-planner-and-step-plan-are-distinct-stages.md)): the feature plan orders engine-internal generation only and is never shown to the user; the Step list is the user-facing, previewable plan generated once at `Approve`/`Preview`.
_Avoid_: Plan (unqualified), build plan, step plan


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
One data source the user has already connected that a `Step` may write a query against, together with the tables it actually contains — read through the connector's own schema introspection at plan time, never from the PRD's wording. Enumerated once per approval and shown to both the planner and each query Step, which may only name a source from that list. Limited to the SQL family for querying; for table creation, narrower still — only ToolJet DB and a connected `postgresql` source receive a `CreateTable`, and only the latter behind an `External write confirmation`. Every other kind (MySQL, MSSQL, Mongo, etc.) never receives one (see [ADR-0018](docs/adr/0018-data-source-selection-removes-createtable-from-the-plan.md), [ADR-0019](docs/adr/0019-createquery-targets-connected-sql-sources-from-a-schema-it-was-shown.md), and [ADR-0042](docs/adr/0042-createtable-may-target-a-connected-postgresql-source-behind-confirmation.md)).
_Avoid_: External database, connection, datasource

**External write confirmation**:
The execution-time pause a `CreateTable` `Step` sits in only when its resolved target is a connected PostgreSQL source, never ToolJet DB — between the step becoming `running` and the DDL/seed-row writes actually being issued. The run UI must show the table name, columns, target connection, and seed row count before the user's explicit go-ahead; declining leaves the step un-executed, the same as a `Skip`, but the two are distinct concepts — Skip declines to build a step at all, this gates a step the user does want built. A plan-time name collision against the target source is a separate, earlier check: it fails the step before this confirmation is ever reached. See [ADR-0042](docs/adr/0042-createtable-may-target-a-connected-postgresql-source-behind-confirmation.md).
_Avoid_: Approval, write gate, DDL confirmation

**Interrupt**:
A pause point inside an approved plan's execution that only a human can resolve — currently `select_datasource` (`CreateQuery` against a connected source, no `data_source_id` given, and more than one is connected: a genuine ambiguity, not a model mistake to retry). Raised via an `interrupt` SSE event carrying `{interruptId, type, payload}` on the same `approvePrd` stream `External write confirmation` already pauses; the run's connection stays open and its side-channel poll (over `conversation.metadata.interrupt`, not a Step column — see [ADR-0044](docs/adr/0044-interrupt-model-pauses-a-run-on-conversation-metadata.md)) is the same checkpoint shape as that confirmation gate, generalized. `Interrupt` only applies to `approvePrd`'s single long-lived connection — PRD-time ambiguity is not an `Interrupt` (see ADR-0044's Scope): `sendUserMessage` is turn-based, and `PRD_SYSTEM_PROMPT` already asks clarifying questions as plain chat before a PRD is ever approved, so there is no live connection to pause at that stage.
_Avoid_: Confirmation (that's the separate `External write confirmation` concept), question, prompt

**Resume** (an Interrupt):
The `POST /ai/conversation/:id/interrupt-answer` call that answers a still-live `Interrupt`: a stale or already-answered `interruptId` 409s, the same guard shape a stale `Step` confirmation gets. Resolving is a plain write to `conversation.metadata`, not SSE — the paused run's own poll notices the answer on its next tick.

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

**Thread token usage**:
The prompt/completion/total token counts summed across a `Conversation`'s currently-`isLatest` messages, from `GET /ai/conversation/:conversationId/token-usage` (ticket #64). Read from `AiConversationMessage.metadata.usage`, populated only when the message was persisted from a provider response that reported usage — captured today on the two chat-send paths (`sendUserMessage`, `sendUserDocsMessage`), not on the `AIGatewayGenerate` paths (plan/step execution, Copilot, Fix with AI). A message with no recorded usage is excluded from the sum, not treated as an error; a message superseded by `Regenerate` is excluded along with it (see [ADR-0027](docs/adr/0027-thread-token-usage-lives-in-message-metadata.md)). Distinct from `ai_chat_prompts`' `credits_used`, which nothing in the server writes.
_Avoid_: Token count, credits used, billing usage

**Tagged resource**:
A datasource (later, a table) the user explicitly attaches to the homepage prompt bar while composing their prompt, passed as `taggedResources: { datasources, tables }` through the create-app handoff (`state: { prompt, taggedResources }`) into the builder store's handoff alongside the `handoffPrompt` (ticket #47). Deliberately separate from the prompt text — selection happens outside it via a picker, not inline mentions — and from a `Queryable data source`: a tagged resource is a user-stated intent carried into the builder, not a planner-verified query target. What the Generate flow does with it (system-prompt context vs tool args) is scoped to its own ticket.
_Avoid_: Mention, reference, attachment

**Generation engine (`generation-engine/`)**:
A standalone Node/TypeScript service built on Fastify (ADR-0029) — the owner of the fork's generation prompts (`generation-engine/src/prompts/*.ts`, ticket #93, ADR-0030, `prompts/index.ts` as the sole import surface) and of the component/event catalogs. Three endpoints: `POST /generate/prd` — token-by-token PRD text over SSE via `streamText`, using its own `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL` env until effective LLM config per request (ADR-0027, ADR-0031); `POST /generate/run` — the full from-scratch pipeline (see Pipeline stage) over SSE (#121); `POST /generate/steps` — an approved PRD in, a step plan JSON out, running the pipeline minus classify/PRD (ADR-0048). Stateless by design: no ORM/RBAC/DB dependency, no persistence of its own — it proposes, ToolJet executes. `AiService` proxies PRD streaming through `GenerationEngineClient` (ADR-0036) and step planning through `GenerationEnginePipelineClient` (ADR-0048) when `GENERATION_ENGINE_URL` is set, falling back to the in-process paths otherwise; that silent fallback is scheduled for removal by the hard switch (ADR-0050). Auth: static `ENGINE_API_KEY` bearer token on every endpoint except `/health`, fail-closed (ADR-0032 amendment). Built by the root `build` orchestration chain (`build:generation-engine`); at runtime it deploys as its own container (ADR-0032), separate from the `tooljet-ce:local` image.

**Component/event catalogs (`generation-engine/src/catalogs/`)**: Built from scratch in ticket #92 per ADR-0033 — not migrated from the fork's `server/src/modules/ai/helpers/componentsMeta.json` (an 11-widget post-hoc validator) or the single hardcoded event in `agents.service.ts`. Two vocabularies (ADR-0037): the **component catalog** (`ComponentCatalogEntry`, one per widget — properties with a value-shape plus the component's own `triggers`) and the **event catalog** (`EventActionSpec`, keyed by the kebab-case `actionId` the `event_handler` entity actually persists, e.g. `run-query` — sourced from `ActionTypes.js`, not the unrelated camelCase `ACTIONS` code-hint list). Consumed by the pipeline's prompt assembly (`src/pipeline/prompt-assembly.ts`, which serializes `toPromptContext()` into generation prompts — per-entity generation and the LLD stage consult it). The component catalog covers 11 core generation types and is scheduled to reach the fork's full 36-type allow-list in the active unification plan (Part 2, Task 5).

**Effective LLM config**:
The resolved `{provider, model, apiKey, baseURL?}` envelope that crosses the server→Generation engine boundary for one request — either the org's decrypted BYOK settings or the env-configured fallback, already resolved before it reaches the engine. The engine never reads `organization_ai_keys` or decrypts anything itself (ADR-0038); it is a pure `EffectiveLlmConfig -> language model` function, matching `EffectiveAiConfig` in `server/src/modules/ai/interfaces/IAiKeySettingsService.ts` but without the `source`/`contextWindow` fields the server keeps for itself.
_Avoid_: Provider config, resolved credentials (when the ambiguity between the server's and the engine's copy matters)

**Pipeline stage (`generation-engine/src/pipeline/`)**:
The engine's internal generation sequence per ADR-0028 (as extended by ADR-0040 and ADR-0048): classify -> PRD -> LLD -> feature-planner -> per-entity generation -> step-plan -> step-generation -> evaluate, implemented in tickets #95/#109/#121/#130. Each stage is a `PipelineStage` (`types.ts`) that reads and extends a single accumulating `PipelineArtifacts` bag; `orchestrator.ts`'s `runPipeline` sequences them, short-circuiting on the first failure and naming which stage failed (`PipelineStageError`). Each stage module splits into a deterministic half (tool-call/schema parsing, routing, topological ordering — unit-tested per ADR-0034) and an injected LLM-calling half (a `deps` function the stage calls). `step-plan` (ADR-0040) is the terminal planning stage producing the user-facing `Step` list; `step-generation` (ADR-0048) dispatches every non-`CreateTable` step's payload through its ported system prompt into `artifacts.generatedSteps`. The evaluate stage's pass/fail contract (fail-closed on unparseable judge output, non-throwing on a failing verdict) is recorded in ADR-0039.
_Avoid_: Pipeline phase, generation phase (reserve "phase" for the planner's own step-plan phases, ADR-0021)

**AI provider settings**:
The org-scoped BYOK configuration a workspace admin manages under Workspace settings → AI provider (`key-settings`/`update-key`, ticket #59 backend; admin UI ticket #65): which `LlmProvider` (`openai`/`anthropic`/`gemini`/`grok`/`openrouter` — `tooljet_managed` is stored but never routed to in CE, see `AiKeySettingsService.getEffectiveOrgConfig`) and model the org's key targets, or `useEnvironmentConfig: true` to fall back to the server's `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL` triple instead. The key itself is write-only from the client's perspective — the API returns a masked placeholder, never the plaintext, and switching provider requires supplying a new key rather than reusing the old one. Takes effect on the next AI Gateway call; nothing restarts.
_Avoid_: LLM settings, model settings, API key page
