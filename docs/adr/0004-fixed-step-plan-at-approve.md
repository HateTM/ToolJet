---
status: accepted
---

# Fixed Step plan generated once at approve, not a live agentic loop

`graph.service.ts` is currently a CE no-op (`'GraphService is not available in Community Edition'`), so neither a real step-planner nor a live agent loop exists yet. AI SDK's multi-step tool-calling would support either: a live loop where the model picks each next tool based on current `App` state, or a plan generated once and executed in order.

Decided: `approvePrd` generates the full ordered `Step` list once, from the approved PRD. Execution walks that list in order; each `Step`'s concrete props (e.g. real IDs of tables/columns created by earlier steps) are filled in by a per-step LLM call with prior-step results in context, but the plan's shape (which steps, in which order) doesn't change after approval.

Rejected: a live agentic loop where the model decides each next step during execution. It's more flexible, but breaks the meaning of "approve" — if the model can deviate from what was shown, the user isn't approving a plan, just a prompt. A fixed plan also gives clean `rewind-step` semantics (rewind to step N of a known list) and a real progress indicator ("step 2 of 5").
