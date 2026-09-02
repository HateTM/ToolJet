# ADR-0049: Deterministic consumption of generated step payloads

## Status

Accepted (2026-09-03). Follows through on the future work explicitly left open by
[ADR-0048](0048-wire-generation-engine-pipeline-into-step-planning.md).

## Context

ADR-0048 wired the generation engine's 8-stage pipeline into server step planning. The
engine produces plan-time tool payloads for all non-table step types (CreateComponent,
UpdateComponent, DeleteComponent, MoveComponent, CreateQuery, UpdateQuery, DeleteQuery,
GenerateEvent), and `persistProposedSteps` stores them on Steps as `props.generatedStep`.
Until now that field was inert: every executor unconditionally made its own execution-time
LLM call, discarding the plan-time payload (and overwriting `props` on success).

Plan-time payloads are advisory: they are produced from the PRD, the rendered component
index and earlier plan steps, without live execution-time state. `plannedTable` and
`props.collisionError` are the established precedents for plan-time contracts read at
execution start.

## Decision

Executors consume `props.generatedStep` deterministically via a single shared helper,
`resolveGeneratedStepArgs` (`server/src/modules/ai/helpers/generated-step-args.ts`), with
this policy:

1. **First attempt only.** The payload is consumed when `previousError` is undefined.
   Once an attempt fails, retries go back to the LLM with the error as feedback — the
   only path that can produce a *different* result. Replaying a failed fixed payload
   would burn attempts.
2. **Shape-gated.** A payload missing the step type's required args (wrong kind or
   absent) is treated as absent: the executor falls through to its LLM path in the same
   invocation. This mirrors the `plannedTable` policy (malformed plan → per-step LLM).
3. **No new validation.** A well-shaped payload is wrapped in a synthetic tool call and
   flows through the executor's existing guards and validators untouched. A payload that
   is wrong about live state (unknown componentId, unsupported component type, unknown
   queryName, invalid event body) throws the same retryable errors as an LLM answer, so
   attempt 2 runs the LLM with that error as feedback.
4. **Consumption skips only the prompt-build and LLM call.** Everything downstream —
   guards, agentsService calls, returned props shapes, SSE reporting, artifact
   persistence — is byte-for-byte the LLM path's behavior.

CreateTable/UpdateTable are out of scope: their plan-time contract (`plannedTable`,
`plannedSeedRows`) already has a deterministic path (ADR precedent, executeCreateTableStep /
executeUpdateTableStep).

## Consequences

- The generation engine's payloads become effective: on a healthy plan, non-table steps
  execute without an LLM call — cheaper and faster, and the plan is what runs.
- The retry loop is unchanged and remains the safety net: any deterministic failure
  degrades to the existing LLM-with-feedback behavior on the next attempt, never to a
  hard failure the LLM could have avoided.
- `props.generatedStep` is consumed, not preserved: on success the executor's returned
  props overwrite it, exactly as the LLM path always did.
- No DB migration, no new dependencies, no frontend changes. The engine contract
  (`EngineGeneratedStep`, route `/generate/steps`) is untouched.
