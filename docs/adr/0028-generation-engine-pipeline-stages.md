# ADR-0028: Generation engine pipeline — classify → PRD → LLD → feature-planner → per-entity generation → evaluate

Date: 2026-09-01
Ticket: #82 (pipeline stages the Generation engine runs)
Status: Accepted

## Context

The Generation engine replaces the fork's current single-shot `ai` module generation logic and needs an internal pipeline shape. The existing fork has no LLD stage, no feature-planner, and no evaluation step — it goes more or less straight from prompt to PRD to a flat step plan. The EE reference (architecture only, not code/prompts — `ee-extract/analysis/ai-server-engine.md`) runs a richer multi-stage pipeline. Whatever is chosen must stay inside the unchanged `PRD → Approve → fixed Step-list` contract (ADR-0001, ADR-0004): the engine only generates, it does not decide when the user reviews or execute anything.

## Decision

Adopt the full EE-inspired stage sequence: **classification → PRD → LLD (DB schema, no data seeding) → feature-planner → per-entity generation (separate create/update tool-calls per entity type) → evaluate (LLM-as-judge post-processing)**. All of this happens inside the engine and produces the same PRD/Step-list artifacts the server already expects; the contract itself is not reopened.

Layout generation/post-processing is explicitly **not** part of the engine — it is already deterministic server-side code (ticket #63, `ai: deterministic component layout for AI Builder`) and stays there.

## Consequences

- The engine's internal stage boundaries (classify/PRD/LLD/planner/per-entity/evaluate) are free to evolve independently of the server, as long as the PRD and Step-list shapes at the boundary don't change.
- LLD explicitly excludes data seeding — seeding real datasource tables stays server-side (`seedPostgresDatasource`/`seedMongoDatasource`), out of scope for this map (see issue #79, "Out of scope").
- Evaluate/LLM-as-judge is a new stage with no fork precedent; its concrete pass/fail contract with the rest of the pipeline is left to implementation, not fixed by this ADR.

## Note (2026-09-01, ticket #110): the pipeline's PRD stage is a plain LLM call

The engine-side `prd` pipeline stage does **not** reuse #91's `streamPrd`/SSE seam. It
stays a plain (non-streaming) LLM call inside the pipeline: streaming to the browser is
the server proxy's concern (ADR-0027), #91's `POST /generate/prd` route remains the
streaming PRD path end-to-end, and #113 will stream the PRD artifact over SSE from the
proxy. The pipeline stage exists for non-streaming/internal callers (e.g. batch
regeneration); duplicating the prompt is avoided by both using the same
`prompts/prd.ts` system prompt from the #93 library.
