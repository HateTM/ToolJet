---
status: accepted
---

# Promoting a Learn conversation to building starts a new Generate conversation, rather than switching the existing one's type

A user in a Learn conversation who decides they want something built needs a way into the Generate flow. The alternative considered was mutating the existing `AiConversation.conversationType` from `'learn'` to `'generate'` in place, keeping the same conversation id and message history.

That was rejected because `conversationType` is already load-bearing as a fixed property of a conversation: `listConversations` filters by it, and every Generate-only operation (`approvePrd`, `rewindStep`, the `Artifact` trail) assumes every message in the thread it's operating on belongs to a conversation that was Generate from message one. Allowing an in-place type change means either those code paths have to handle a thread whose early messages have no PRD/Step/Artifact concept, or the UI has to render two different message shapes in one timeline and figure out where the seam is. Neither of those is required by the actual user need, which is just "start building based on what I just learned" — not "retroactively reclassify this conversation."

`Promote` instead creates a fresh `AiConversation` with `conversationType: 'generate'`, and seeds its first message with a `Context seed` — the triggering question and answer, not the full Learn history. The original Learn conversation is left exactly as it was and stays independently accessible. This keeps `conversationType` fixed-for-life (already true for every other conversation), at the cost of the new Generate conversation not literally being a continuation of the same thread — a cost the user doesn't see, since the seed carries forward the part of the context that mattered.
