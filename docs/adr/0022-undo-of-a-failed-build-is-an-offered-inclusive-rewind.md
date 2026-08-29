# ADR-0022: Undo of a failed build is an offered, inclusive rewind to the plan's first step

Date: 2026-08-29
Ticket: #15 (automatic rollback of a partially-executed plan on failure)
Status: Accepted

## Context

A plan that fails at step N stops execution but leaves the N−1 succeeded steps' Artifacts applied (ADR-0008's rewind is manual and per-step; full automatic rollback was explicitly out of scope for v1). Issue #15 asked whether rollback should be automatic-on-failure or an offered action, and whether it reuses ADR-0008's artifact-discard mechanism.

## Decision

Rollback is an **offered action, not automatic**: once a plan has stopped on a failure, a resting "Undo this build" action appears in `StepProgressList`. It reuses ADR-0008's discard rather than adding a parallel one — implemented as a new `inclusive` mode on `rewindStep` in which the target step itself is undone along with every step after it. "Undo the whole build" is exactly an inclusive rewind to the plan's first step. The frontend calls the existing `rewind-step` endpoint with `inclusive: true`; no new endpoint, repository method, or discard loop exists.

## Alternatives considered

- **Automatic rollback on failure.** Lost: a plan that fails at step 6 of 8 has still built five things the user may well want to keep, and discarding is the one part of this flow that cannot be undone. Keeping the destructive path opt-in leaves the failure recoverable in both directions.
- **A dedicated `undo-build` endpoint with its own discard loop.** Lost: a second implementation of the artifact-discard ordering can drift from ADR-0008's (reverse-order undo, reset-to-pending, fail-stop). The inclusive flag buys the whole behaviour for three lines inside the existing loop.
- **Rewinding non-inclusively to the first step.** Lost: it keeps the first step's Artifact, so "undo the whole build" would silently leave the plan's first change applied — surprising precisely because the button says *undo this build*.

## Consequences

- The failure path itself is unchanged: a failing plan still stops and leaves prior Artifacts applied, exactly as before this ADR.
- ADR-0008's contract changes in one respect (see the amendment banner there): with `inclusive`, the target step's own Artifact is reverted and its row reset too. Without the flag, ADR-0008 holds verbatim.
- The offer appears only on a stopped plan that both failed somewhere and succeeded somewhere before that — a plan that failed at its first step built nothing and gets no undo offer.
- The store keeps the plan visible with every step reset to `pending` after an undo (the resting state), rather than dropping the step list; re-running remains a re-approve, as with rewind.
