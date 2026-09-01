---
status: accepted
---

# Thread token usage is aggregated from `message.metadata.usage`, captured only on the two chat-send paths

Ticket #64 asks for a real `GET /ai/conversation/:conversationId/token-usage`, summing prompt/completion/total tokens across a thread's messages, tolerant of messages that carry no usage figure.

## Where usage is recorded

`server/src/entities/ai_chat_prompt.entity.ts` (`ai_chat_prompts`, with a `response: json` column and `credits_used`) already looks purpose-built for this — but it is referenced by zero files anywhere in the server. Nothing writes to it, `AiConversationMessage.promptId` never gets set, and wiring a real writer for it (and a repository, and linking it back to the message) is a bigger, separate piece of work with no other consumer today.

Decided: usage is captured into `AiConversationMessage.metadata.usage` (`{ promptTokens, completionTokens }`) at the point each AI message is persisted — the same `metadata` JSONB column already used for other message-scoped facts (e.g. `feasibility` in `approvePrd`). `getThreadTokenUsage` sums that field across a thread's messages. `ai_chat_prompts` stays unused; resurrecting it is out of scope for this ticket.

## Where it is captured

The AI SDK (`ai@^4.3.19`) result of both `streamText` (`AIGateway`) and `generateText` (`AIGatewayGenerate`) exposes a `.usage` promise resolving to `{ promptTokens, completionTokens, totalTokens }` once generation finishes. There are two `AIGateway` (streaming) call sites — `sendUserMessage` and `sendUserDocsMessage`, the two paths that persist a user-facing chat turn — and roughly eight `AIGatewayGenerate` (non-streaming) call sites across `approvePrd`, `previewPlan`, `fixWithAi`, `copilot`, and step planning, none of which persist an `AiConversationMessage` the same way (they persist `Step`/`Artifact` rows, or nothing at all).

Decided: only the two `AIGateway` chat-send paths capture usage (`captureUsageMetadata`, a small helper that never throws — a provider that omits usage should not break message persistence). The `AIGatewayGenerate` sites are **not** wired in this ticket; a message produced by them (e.g. the PRD message from `approvePrd`) has no `metadata.usage` and is correctly excluded from the sum by AC2 ("messages without usage don't break aggregation"), not treated as an error. This means `getThreadTokenUsage`'s total under-counts a thread that has gone through `approvePrd`/plan execution — it is deliberately scoped to the conversational turns, matching where a user actually experiences token cost building up message-by-message. Extending capture to the generate-only paths is real, but separate, work; a caller of this endpoint should not read its number as the org's full LLM spend for the thread.

## Which messages get summed

`getThreadTokenUsage` reads through `AiConversationMessageRepository.findLatestByConversationId` — the same method `getConversationById` uses — which filters to `isLatest: true`. `regenerateAiMessage` (ADR-0009) flips a superseded AI reply to `isLatest: false` when a new one is generated; that superseded reply's usage (if it had any) is excluded from the sum along with the reply itself.

Decided: keep the `isLatest`-only view rather than adding an all-messages read. This matches "thread token usage" to what the user currently sees in the transcript, not a running total of every attempt including ones that were regenerated away — consistent with how the rest of the AI Builder treats a regenerated reply as replaced, not merely superseded-but-still-counted. A caller that wants true cumulative spend across every regeneration needs a different query (`findAllByConversationId`, unfiltered) — not built here, no consumer needs it yet.
