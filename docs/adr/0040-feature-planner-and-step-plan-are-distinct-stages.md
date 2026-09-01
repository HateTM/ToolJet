# ADR-0040: Feature-planner and step-plan are two distinct stages — feature-planner does not subsume the Step-list planner

Date: 2026-09-01
Ticket: #112 (settle feature-planner vs. step-plan: same stage or two?)
Status: Accepted

## Context

ADR-0028 places feature-planner after LLD but leaves its relationship to the fork's
existing PRD → Step-list planner (`proposeStepPlan` in `server/src/modules/ai/
service.ts`, the `Step` contract of ADR-0001/ADR-0004) unsettled. #93 flagged it as
known gap #2 and left it as an OPEN QUESTION doc comment on `feature-planner.ts`; #95's
implementation treats feature-planner as LLD → FeaturePlan only and does not call
step-plan at all — flagged by two tickets without being settled.

Three shapes were on the table: feature-planner subsumes step-plan (one stage produces
both the FeaturePlan and the Step list), feature-planner wraps it, or they are genuinely
separate stages.

## Decision

**Two distinct responsibilities, two distinct stages.**

1. **feature-planner is engine-internal.** It consumes the LLD and produces the
   topological FeaturePlan — the grouping/ordering of tables/entities that per-entity
   generation routes against. It never produces user-facing steps and never touches the
   Step-list contract.
2. **step-plan is the terminal planning stage.** It consumes the PRD + LLD (+ the
   FeaturePlan ordering as a dependency hint) and produces the fork's Step-list contract
   exactly as `proposeStepPlan` does today — the ordered `{ steps: [{ type, description,
   table?, seed_rows?, phase? }] }` shape of ADR-0001/ADR-0004, unchanged. It sits in the
   default pipeline after per-entity and before evaluate:
   classify → PRD → LLD → feature-planner → per-entity → **step-plan** → evaluate, so
   evaluate judges a plan that already includes the Step list. This ordering is an
   internal stage-list evolution, which ADR-0028 explicitly permits as long as the PRD
   and Step-list shapes at the boundary don't change — and they don't.
3. **Rejected: subsuming.** Folding the Step list into feature-planner would couple an
   engine-internal routing concern (table dependency order) to the user-facing,
   previewable contract — any evolution of one would drag the other, and ADR-0004's fixed
   plan semantics (generated once at approve, shape frozen) would attach to what is
   really just a generation-ordering artifact.
4. **Rejected: wrapping.** A stage that internally calls step-plan and returns both
   artifacts has the same coupling with less clarity, and denies step-plan its own
   deterministic half (input assembly, response parsing/validation) to test per ADR-0034.

## Consequences

- The pipeline artifact bag gains `stepPlan`. The server-facing contract (PRD and
  Step-list shapes) is unchanged — the engine simply produces, as a stage, what the
  server's `approvePrd` flow produces today.
- `feature-planner.ts`'s OPEN QUESTION comment is resolved by this ADR.
- The fork's plan-time policy carries over verbatim: a malformed planned table or
  seed-row list on a step is dropped (the step persists), while a missing/empty/malformed
  steps payload is a hard validation error — the same behaviour as
  `isWellFormedTableDefinition` and the "did not propose a build plan" throw in
  `service.ts`.
- Phases (ADR-0021) ride the same stage: `phase` is optional on each proposed step,
  planner-assigned, and validated as a string when present.
- Per ADR-0034, the stage's deterministic half (input assembly, parsing/validation,
  stage wiring) is unit-tested; the step-plan prompt's quality is checked manually.
  No step-plan prompt exists in the engine yet (`prompts/` per ADR-0030) — wiring the
  real ported prompt into `deps.generateStepPlan` remains #93's.
