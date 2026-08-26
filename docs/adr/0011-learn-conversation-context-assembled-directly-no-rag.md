---
status: accepted
---

# Learn conversation context is assembled directly per message, not retrieved from an indexed store

`sendUserDocsMessage` needs to ground its answers in something. The obvious-looking path for a "Q&A over docs" feature is retrieval-augmented generation: embed the content, store it in a vector index, run similarity search per question. That path was rejected for v1.

The content a Learn conversation actually answers against — the current App's pages, components, data sources, queries, and its own Generate conversation history — is small and bounded per App: dozens of objects, not a large corpus. That fits directly in the LocalAI-compatible model's context window without retrieval, and the App is already fully queryable through existing repositories, so "assemble the App inventory fresh" is a straight read, not a new subsystem. This project also has zero embedding/vector-store infrastructure today (`AiService` only calls a chat-completion endpoint via `@ai-sdk/openai`) — standing one up for a bounded-size, single-App context would be infrastructure built for a scale this feature doesn't have.

If a future ticket needs Learn conversations to answer against something large — ToolJet's own product documentation, or App history across a very long-lived App — that's the point to revisit retrieval. Building it now, against content that already fits in-context, would be solving a problem this ticket doesn't have.
