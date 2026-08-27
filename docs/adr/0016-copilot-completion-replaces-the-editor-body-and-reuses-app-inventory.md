---
status: accepted
---

# A `Completion` is reviewed then written over the whole editor body, and its context is the existing `App inventory`

Two of ticket #33's open questions are really one question — how much does the assistant know, and how much is it allowed to overwrite — so they are decided together here.

## Context: reuse `App inventory`, don't invent a second assembler

A `Fix with AI` request carries no app context at all: one failing expression plus one error message determine the answer, and ADR-0013 says so explicitly. `Copilot` has the opposite problem. "Fetch the users and group them by team" is unanswerable without knowing that a query named `getUsers` exists and what a `Table` on the page is called — a model given only the empty editor body will invent plausible names, and every invented name is a binding that silently resolves to `undefined` at runtime.

`App inventory` (ADR-0011) already assembles exactly that — pages, component names and types, data sources, queries — freshly, per request, from the same repositories, with no index to keep in sync. `AiService.assembleAppInventory(appId)` already resolves the version itself. Decided: `POST /ai/copilot` takes an `appId` and grounds the prompt in that same inventory, plus the editor's own current code, its language, and the kind of data source it belongs to. No second context assembler is written, and `appId` is optional — an editor that cannot supply one still gets an ungrounded completion rather than an error, which is worse but not nothing.

The inventory is not free: it is assembled on every copilot request, the same way it is on every Learn message. That is the trade ADR-0011 already accepted for bounded, per-App content, and a copilot request is deliberate and rare rather than per-keystroke (ADR-0015), so the cost lands in the same place.

## Apply: whole-body replacement, shown before it lands

`onAiSuggestionAccept(newValue)` — the seam `MultiLineCodeEditor` hands to `renderCopilot` — sets `currentValueRef.current` and calls `onChange(newValue)`. It replaces the field. There is no insert-at-cursor and no patch application anywhere in this editor, and building one would mean owning cursor position, indentation, and conflict behaviour for a value the model wrote blind.

Decided: a `Completion` is the complete replacement body, and Apply writes it verbatim through `onAiSuggestionAccept`, exactly as `Fix with AI` writes a `Suggestion`. What makes that safe is not a diff view but the prompt: the editor's current code is sent as context with an instruction to extend and preserve it rather than start over, and the returned code is rendered in the popover — the same code, verbatim, that Apply will write — so the user reads it before anything is overwritten. Retry replaces the pending `Completion` instead of appending; dismiss leaves the editor untouched.

Whole-body replacement is also what decides how the existing code is bounded in the prompt. A fix's fallback value can be trimmed freely — it is only there to show a shape. The editor's body cannot: show the model half of it and it is being told to "keep the parts you weren't asked to change" while blind to them, and the half it never saw disappears the moment Apply writes the result. So the body is sent whole, under a bound set far above any real query, and past that bound it is dropped from the prompt entirely with the model told it is writing blind and required to open its explanation with a warning. A completion that admits it replaces rather than extends is one the user can decline; a quietly lossy one is not.

A side-by-side diff was the alternative and is a real improvement over a `<pre>` when a completion edits a long existing body. It is deferred rather than rejected: it needs a diff component this fork does not have, and it changes nothing about the request, the endpoint, or the apply seam — so it can be added later as a rendering change inside the popover with no other consequence.

## Not a `Conversation`

Same reasoning as ADR-0014, and it applies unchanged: one prompt in, one `Completion` out, nothing written to `ai_conversations`/`ai_conversation_messages`, no `conversationId`, not streamed. The user's only moves are apply, retry, or dismiss — there is no second turn to persist, and a query editor is not where someone goes to have a conversation. Structured output comes from a single forced tool call through `AIGatewayGenerate` (ADR-0003), like every other AI Builder feature.

That also settles the ticket's auth question. The legacy path — `copilot.service.js` posting to a hosted `POST /copilot`, `validateCopilotAPIKey` against a ToolJet-issued key, `CopilotRequestDto`, and the `AgentsService.copilot` stub — is deleted, not revived. A self-hosted fork has no counterpart to that key, `getRecommendation` (its only caller) was already unreachable, and routing through `AIGateway` is what makes this feature use the same configured LocalAI endpoint as the rest of AI Builder instead of a second, separately-credentialed provider.
