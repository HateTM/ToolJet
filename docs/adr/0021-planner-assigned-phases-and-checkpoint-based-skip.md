# ADR-0021: Planner-assigned phases and checkpoint-based skip

Date: 2026-08-29
Ticket: #21 (group step plan into named phases with per-step skip/continue)
Status: Accepted

## Context

An approved plan executes as one flat ordered list of Steps, streamed end-to-end with no user input between approve and `done` (ADR-0005). The reference AI Builder UX shows steps grouped under named phase headers ("Phase 1 · Create data queries [5/7]") and offers per-step skip/continue controls during execution, so the user can drop a step without rewinding after the fact.

Two questions had to be settled:

1. Is a **phase** a first-class planner concept or derived client-side from step types/order?
2. How does **skip** interrupt an execution that is already streaming over SSE (ADR-0005)?

## Decision

**The planner assigns phases.** `proposeStepPlan` takes an optional `phase` string per step; the system prompt asks for 1–4 short human-readable phase names, repeated verbatim across consecutive steps of the same phase. The label is persisted on the Step (nullable `phase` column), rides the `plan` SSE event and the preview-plan response, and the client groups the flat list into consecutive runs of the same label. Steps without a phase (pre-#21 plans, blank planner output) fall into a single unnamed group.

- Rejected: deriving phases client-side from `StepType`/order. Cheaper, but it can only ever produce the three hard-coded type names — it cannot express intent ("Set up app interactions") and would have to be rewritten anyway the moment the step vocabulary grows. The planner already knows the PRD; naming the group it is building costs one optional field.

**Skip is checkpoint-based, not an interrupt.** `POST /ai/conversation/skip-step` records the user's decision by marking a `pending` or `running` Step `skipped`; it never interrupts in-flight work. The `approvePrd` execution loop acts on it at two checkpoints:

- before starting a step — a skipped step never starts and produces no Artifact;
- after the outcome lands — a step skipped mid-execution has its successful Artifact undone through the same calls `rewindStep` makes (`undoArtifact` + artifact delete), so a skipped step never leaves anything behind.

Because the loop runs concurrently with the skip endpoint, the retry executor guards both of its terminal status writes: a step already marked `skipped` is never overwritten with `succeeded` or `failed` — otherwise a skip landing mid-run would be silently clobbered by the very outcome it was meant to discard, and skip would only win in the tiny window after the terminal write. The executor reports `skipped` on its result instead, and the loop turns that into a new `step-skipped` SSE event, which the client uses to mark the step — visually distinct from succeeded/failed (strike-through + skip icon) — while the plan continues to the next step automatically.

- Rejected: pausing the plan before every step to await a per-step confirm (the reference's full wizard). That is a different interaction model — it would require the SSE loop to block on client input and a "Continue" affordance to resume, for a benefit v1 does not need. "Continue" is therefore implicit: execution keeps running, skip is the only per-step decision.
- Rejected: interrupting a running step's LLM call. The retry loop (ticket #4) would need cancellation plumbing through every handler; discarding the outcome at the checkpoint gives the same end state with none of the plumbing.

**Interactions.** With retry (#4): skip wins — a step marked skipped mid-run is never recorded with a terminal status, and even a step that succeeded after all `MAX_STEP_ATTEMPTS` has its Artifact undone and is reported `step-skipped`. With rewind (#7): a skipped step has no Artifact, so rewind passes over it; rewind resets skipped steps to `pending` like any other, so a re-approved plan can include them again. A `failed` step cannot be skipped (the plan has already stopped; redo is rewind + re-approve).

## Consequences

- Old plans (no `phase`) render exactly as before — one unnamed group, no phase headers.
- The per-phase "N/M" counter counts succeeded + skipped steps as resolved.
- A step skipped while running burns its LLM call; the cost is accepted in exchange for not building cancellation plumbing.
- The reference's richer planning vocabulary (steps like "Discover relevant tables" that map to no `StepType`) is explicitly out of scope here — see the issue's closing comment.
