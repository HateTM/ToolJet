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
The user action that locks in a PRD and starts execution. Generates the full ordered `Step` list once, from the PRD — the plan's shape doesn't change after this point, only each Step's concrete props get filled in as execution reaches it (see [ADR-0004](docs/adr/0004-fixed-step-plan-at-approve.md)). One-way: there's no "un-approve," only rewinding executed steps.

**Step**:
One unit of execution against the `App`, run after a PRD is approved. Each `Step` produces exactly one `Artifact`. A Step either creates a Component (v1 target types: Page, Table, Form, Button, Text, TextInput, Container) or creates a Query against a ToolJet DB table — see [ADR-0002](docs/adr/0002-generic-component-tool.md).

**Artifact**:
The concrete output of one `Step` — the generated/changed piece of the `App` (e.g. a component, a table). Persisted as `Artifact`, linked to the `Conversation` and to the specific AI `Message` that produced it.
_Avoid_: Output, result, generation

**Rewind**:
Undo execution back to an earlier `Step`, discarding the `Artifact`s made after it. Applies within a single approved PRD's execution, not across PRDs.

**Regenerate** (a message):
Re-run a specific AI response in place, branching off its parent message (`parentId`) rather than replaying the whole `Conversation`. Produces a sibling message; the old one is superseded (`isLatest: false`) but not deleted.
_Avoid_: Retry, redo

**Learn conversation**:
A `Conversation` scoped to Q&A about the current `App` — its structure and its `Generate conversation` history — rather than building. No PRD, no `Step`s, no `Artifact`s. Corresponds to `conversationType: 'learn'`. Answered from an `App inventory`, not from ToolJet's own product documentation — the latter is a separate, unrelated concern.
_Avoid_: Docs mode, Q&A mode, chat mode

**App inventory**:
A distilled, freshly-assembled snapshot of the current `App` — its pages, the type and name of each page's components, its data sources, and its queries — plus a condensed summary of past approved PRDs. Assembled fresh for every message in a `Learn conversation`; never indexed or persisted (see [ADR-0011](docs/adr/0011-learn-conversation-context-assembled-directly-no-rag.md)). Omits layout and styling: a `Learn conversation` answers "what does my app do," not "what is this button's border-radius."
_Avoid_: Docs, knowledge base, context

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
