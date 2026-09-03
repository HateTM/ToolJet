# ADR-0052: Hard switch to the Generation engine, supersede silent fallback

Date: 2026-09-03
Status: Accepted
Supersedes: ADR-0036 decision 1 (flag-guarded fallback), ADR-0048 decision 5 (silent fallback)

## Context

ADR-0036 and ADR-0048 both made the same call for the same reason: the Generation
engine wasn't deployed yet (no ADR-0032 TrueNAS app, no `GENERATION_ENGINE_URL` set
anywhere), so every engine-path call site — PRD streaming (`AiService.sendUserMessage`)
and step planning (`AiService.generateStepPlan`) — falls back silently to the
pre-engine in-process path (`AiUtilService.AIGateway` / `proposeStepPlanTool`) whenever
the engine is unreachable, misconfigured, or simply not configured.

That was the right call while the engine had no deployment and no catalog parity
(11/36 component types — see Part 2, Task 5). It stops being the right call once
both are true: the engine is deployed (ADR-0032, Part 2 Task 6) and its catalog and
step-type coverage matches the fork's (Part 2, Task 5; ADR-0048 already closed the
step-type gap for the nine v1 `STEP_TYPES`). Past that point, a silent fallback stops
protecting availability and starts hiding a real difference in output — the two
paths use different prompts, different catalogs, and can silently diverge in what
they propose. A user who thinks they're getting the engine's (newer, catalog-complete)
generation could be getting the old in-process path with no signal that it happened.

## Decision

1. Once the engine is deployed and catalog/step-type parity is verified (Part 2,
   Tasks 5–6), remove the in-process fallback: `AiService.sendUserMessage`,
   `generateStepPlan`, and `AiService.regenerateAiMessage`'s PRD-regeneration call
   site stop checking `GenerationEngineClient.isConfigured()` /
   `GenerationEnginePipelineClient.isConfigured()` as a soft gate and instead treat
   an absent or unreachable engine as a hard failure.
2. Missing `GENERATION_ENGINE_URL`, or any engine-path failure (unreachable engine,
   non-200, malformed/empty plan, missing effective org LLM config), raises
   `ServiceUnavailableException` back to the client. No response is synthesized by
   an in-process path standing in unannounced.
3. Removal is a Part 2 task (Task 7 in the active plan), executed only after the
   deploy (Task 6) and parity check (Task 5) both land — this ADR fixes the
   decision and its trigger condition now so Task 7 isn't a fresh policy debate
   later, per the plan's "no ждёт задачу" constraint.
4. Out of scope, unaffected by this decision: `sendUserDocsMessage` (Learn/docs
   chat), Fix with AI, and Copilot. None of the three ever routed through the
   Generation engine (ADR-0036's own scope note; Copilot's contract is ADR-0016).
   They keep calling their existing in-process paths unconditionally — there is no
   fallback to remove because there was never an engine path to begin with.
5. **Superseded**: ADR-0036 decision 1 (flag-guarded, not a hard switch) and
   ADR-0048 decision 5 (silent fallback to the in-process planner) — both are
   superseded by this ADR's decision 1–2, effective once Part 2 Task 7 executes
   the removal. Until Task 7 lands, ADR-0036/0048's fallback behavior remains the
   live behavior; this ADR fixes what replaces it and when.

## Consequences

- Every dev checkout and deployment that hasn't set `GENERATION_ENGINE_URL` (or
  whose engine is down) starts failing PRD generation and step planning outright
  once Task 7 lands, instead of degrading to the older in-process paths. This is
  deliberate: post-parity, "silently worse" is judged worse than "loudly
  unavailable."
- `AiUtilService.AIGateway`'s PRD/step-plan code paths, `proposeStepPlanTool`, and
  `prompt-library/` become dead once the fallback call sites are removed — their
  deletion is scoped to Task 7, not this ADR (this ADR is a decision record, not
  the deletion itself).
- `GenerationEngineClient.isConfigured()` / `GenerationEnginePipelineClient
  .isConfigured()` stay as the availability check; only what runs on `false` (or
  on error) changes, from "fall back" to "fail with `ServiceUnavailableException`."
- Re-entry / trigger condition for Task 7: Part 2 Task 5 (catalog parity, 11→36)
  and Task 6 (ADR-0032 TrueNAS deploy) both closed and verified. Before that, this
  ADR records the decision but changes no running behavior.
