# ADR-0054: modify_app routing — heuristic detection, app inventory grounding

Date: 2026-09-05
Status: Accepted

## Context

The generation engine classifies intent (`modify_app` vs create) in its `classify()` stage, but the server never acted on that classification: every generation went through the create pipeline (PRD → LLD → feature-planner → per-entity), so edits to an existing app **regenerated** components instead of patching them. The engine's modify mode — skipping feature-planner/per-entity and grounding the step plan in the existing app — existed but was never reached.

Routing cannot use the engine's `classify()`: it is unimplemented server-side, and `POST /generate/prd` streams tokens without ever classifying. The server needs its own detection signal at the approvePrd → generateSteps boundary.

## Decision

1. **Heuristic detection**: an app that already has components routes through the engine's modify pipeline. Concretely, `appVersionService`'s step-planning call attaches an app inventory snapshot (`AppInventoryService.assemble`) **iff** the app is non-empty (`componentIndex` does not report "none yet"). Intent classification from the engine remains unused.
2. **LLD is required for modify**: the engine accepts `appInventory` only alongside `lld`, and the modify prompt grounds updates in the current ToolJet DB schema. An app with components but **no ToolJet DB tables** stays on the create pipeline — the componentIndex alone still grounds creation, and no synthetic/empty `lld` is fabricated.
3. **Modify steps target existing objects**: the engine's modify-mode step-plan prompt instructs steps to use `targetId` (Update*/Delete*/Move executors) against existing components/queries from the inventory, and sparse-patch semantics (only changed keys) — the contract server-side executors already validate via `sanitizeComponentSection`. `ProposedStep` gained an optional `targetId`.
4. **Execution is unchanged**: executors, approve/interrupt flow (including `review_phase_plan`, ADR-0044 extension) are pipeline-agnostic; only the generation input differs.

This amends ADR-0028: in modify mode the engine's feature-planner and per-entity stages are skipped; the stage sequence applies to the create pipeline. ADR-0052's hard switch to the engine is unaffected — both pipelines run inside it.

## Consequences

- Small apps that "feel like edits" (e.g. a one-component app where the user asks for something new) run the modify pipeline; the prompt handles adding-new within modify mode (CreateTable/CreateQuery only for genuinely new objects). If this misroutes in practice, the heuristic — not the contract — is the knob.
- The engine 400s on `appInventory` without `lld`; the server's `lld &&` guard makes that unreachable, but it couples the two payloads — moving them apart requires an engine change first.
- `classify()` remains dead engine code until/unless a real intent signal is needed (e.g. when "modify a brand-new empty app" becomes distinguishable from "create").
