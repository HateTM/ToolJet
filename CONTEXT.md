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
The user action that locks in a PRD and starts execution. Turns a plan into a queue of `Step`s. One-way: there's no "un-approve," only rewinding executed steps.

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
A `Conversation` scoped to Q&A rather than building — no PRD, no `Step`s, no `Artifact`s. Corresponds to `conversationType: 'learn'`. **Deferred**: out of scope for this build; the `sendUserDocsMessage` endpoint and this conversation type are not being implemented yet.
