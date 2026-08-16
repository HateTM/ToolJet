---
status: accepted
---

# Two-phase PRD → approve → build flow for Generate conversations

The `ai` module's existing stubs (`approvePrd`, `rewind-step`, `regenerate-message`, the `Artifact` entity keyed by conversation+message) all imply a plan-then-execute shape, but nothing actually implements it, and the original EE reference is inaccessible (private repo, no access). We could instead have made each user message directly mutate the `App` — simpler, but it would strand `approvePrd`/`rewind-step`/`Artifact.identifier` with no purpose and give the user no chance to review scope before changes land.

Decided: Generate conversations run in two phases. Phase one is chat-only — the assistant proposes a PRD as a message, no `App` changes happen, and the user can keep refining it. Phase two starts on `approvePrd`: the PRD is executed as an ordered sequence of `Step`s, each producing one `Artifact` applied to the `App`, with `rewind-step` able to undo trailing steps.
