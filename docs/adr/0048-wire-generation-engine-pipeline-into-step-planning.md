# 0048 — Wire the Generation engine pipeline into step planning

Date: 2026-09-03
Status: Accepted
Inherits: ADR-0028 (pipeline stage sequence), ADR-0040 (step-plan as the terminal
planning stage), ADR-0036 (flag-guard shape for GENERATION_ENGINE_URL), ADR-0027
(streaming boundary), ADR-0044 (interrupt model — unchanged).

## Context

The engine's `STEP_TYPES` (generation-engine/src/pipeline/types.ts) declares all nine
v1 Step types, but the engine could only ever generate table content: `per-entity`
handles tables and nothing dispatched the other types, so five of them
(UpdateComponent, DeleteComponent, MoveComponent, GenerateEvent, DeleteQuery) had no
prompts and no payload path at all — declared support without real parity.

Separately, `GenerationEnginePipelineClient` was registered in DI but never called:
`AiService.generateStepPlan` always planned in-process (`aiUtilService.AIGatewayGenerate`
+ `proposeStepPlanTool`), even when `GENERATION_ENGINE_URL` was set; the engine was used
only for streaming PRD text.

Wiring the client in naively is not safe: `POST /generate/run` always runs a PRD from a
raw prompt from scratch (batch/eval consumers depend on that), while `generateStepPlan`
runs on an already user-approved PRD. Reusing `/generate/run` would silently regenerate
a different PRD.

## Decision

1. **New stage `step-generation`** (`generation-engine/src/pipeline/step-generation.ts`),
   sibling of `per-entity`, running after `step-plan` and before `evaluate`: takes the
   non-`CreateTable` steps of `artifacts.stepPlan`, calls each type's system prompt
   through the dispatcher in `llm-deps.ts`, and stores the payloads in a new
   `artifacts.generatedSteps`. The default pipeline becomes eight stages.
2. **New route `POST /generate/steps`** (`generation-engine/src/routes/generate-steps.ts`)
   — deliberately a separate route, not a flag on `POST /generate/run`, because the two
   wire contracts differ (`/generate/run`: raw prompt in, full from-scratch pipeline,
   SSE out; `/generate/steps`: approved PRD in, plain JSON out). Body:
   `{ prd, lld?, componentIndex?, organizationId, llm }`. Stage list:
   `lld` (skipped when `lld` is supplied) → `feature-planner` → `per-entity` →
   `step-plan` → `step-generation` → `evaluate`. `classify` and `prd` never run.
3. **Server wiring**: `AiService.generateStepPlan` checks
   `generationEnginePipelineClient.isConfigured()` and calls `POST /generate/steps` with
   the approved PRD and the rendered component index. The engine's result is mapped onto
   the exact same Step-persistence contract as the in-process planner
   (`isWellFormedTableDefinition` drop, seed-row validation/consistency,
   `resolveCreateTableTarget`, phase trimming) — extracted into
   `persistProposedSteps` and shared by both paths.
4. **Boundary: the engine proposes, ToolJet executes.** The engine only returns JSON
   step payloads; `executeStep`/`executeStepWithRetry` and every step executor stay
   untouched, and the ADR-0044 interrupt model is unaffected. The single seam is
   `generateStepPlan`.
5. **Silent fallback**: any engine-path failure — unreachable engine, non-200, malformed
   or empty plan, missing effective org LLM config — is logged as a warning and the
   in-process planner runs instead. The user never sees a harder failure than before.
   Same policy shape as `streamPrdText`'s flag-guarded fallback (ADR-0036).
6. **LLM config resolution**: `GenerationEnginePipelineClient` resolves the effective
   org config itself via `AiKeySettingsService.getEffectiveOrgConfig` (ADR-0038: the
   server resolves BYOK/env before anything crosses the wire; the engine never reads
   keys). `null` (env fallback row / no key / incomplete config) is an engine-path
   failure and triggers decision 5's fallback.

## Consequences

- The engine reaches real (not declarative) parity with the server's step vocabulary:
  every `STEP_TYPES` entry now has a prompt and a payload path.
- `GenerationEnginePipelineClient` is no longer dead code: the step plan — the
  contract the user approves — comes from the engine when it is deployed.
- Non-table payload generation happens at plan time from plan context (PRD, rendered
  component index, earlier steps). It cannot see execution-time state (live app
  inventory beyond the component index, connected query results), so payloads are
  proposals; executors keep their own execution-time LLM call.
- `props.generatedStep` on persisted Steps is inert data for now — a future ticket may
  make executors consume it deterministically. No migration: `props` already exists.
- **Cypress e2e coverage is intentionally not added.** This is a backend/LLM-pipeline
  change with no new UI; the visible behavior (step list, execution, interrupts) is
  identical regardless of which path produced the plan. Reviewers should expect unit
  coverage (engine + server) instead.
- Risk accepted: plan-time payloads for component/query/event steps are produced
  without the live execution-time context and are therefore advisory until consumed.
- `POST /generate/run` and its batch/eval consumers are untouched.
