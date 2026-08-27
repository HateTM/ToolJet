---
status: accepted
---

# A fix `Suggestion` is a one-shot, non-persisted request — not an `AiConversation`

Every other AI Builder feature so far runs through `AiConversation`/`AiConversationMessage`: messages are persisted, `regenerateAiMessage` branches off `parentId`, `voteAiMessage` records feedback. The obvious question for `Fix with AI` is whether a fix request is just another conversation — especially since the CE store contract `PreviewBox` was written against calls the per-field state `chatHistory` and reads it as a list, which reads like a chat transcript.

It isn't one, and the name is misleading. A fix request has a single input (one failing expression plus its error), wants a single output (one corrected expression), and its accept path is `onApplyFix(newValue)` — writing a value into a form field, not appending a turn to a thread. There is no second question the user can ask: the popover's only controls are Apply, Retry, and dismiss, and `PreviewBox` itself clears the list on every `currentValue` change, so nothing it holds is meant to outlive the edit being made. Persisting it as a `Conversation` would mean every transient typo in a binding expression permanently lands in a thread list next to the user's actual build conversations, and would drag in `conversationType`, `isLatest`, PRD/Step semantics, and `appId` scoping that none of it has a use for.

Decided: `POST /ai/fix-with-ai` is a plain request/response endpoint. It writes nothing to `ai_conversations` or `ai_conversation_messages`, takes no `conversationId`, and returns one `Suggestion` — a replacement expression plus a one-line explanation — produced by a single forced tool call through `AIGatewayGenerate` (ADR-0003), the same structured-output mechanism `approvePrd`'s step execution already uses. It is not streamed: there is nothing to read progressively, and the client can't act on a half-written expression.

The `chatHistory` array in the store is kept as an array anyway, because `PreviewBox` — which is upstream code this fork would rather not fork — already reads `chatList?.length` and passes it around. It holds at most one pending entry and one result entry per field, which is enough for the popover to distinguish "asking", "here's the suggestion", and "that failed, retry". Retry replaces that entry rather than appending to it, so the list never grows into a transcript; if a later ticket genuinely wants conversational back-and-forth on a fix, it will need its own persistence decision, and this ADR is what it should overturn.

`voteAiMessage`/`regenerateAiMessage` therefore do not apply to a `Suggestion` — there is no message id to vote on or regenerate, and Retry covers the only need Regenerate would serve.
