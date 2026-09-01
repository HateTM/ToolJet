# ADR-0031: Generation engine owns the LLM provider config, unchanged 3-variable model

Date: 2026-09-01
Ticket: #85 (LLM provider configuration model for the Generation engine)
Status: Superseded by ADR-0035

## Context

The fork currently configures its LLM access with three environment variables (`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `AI_MODEL`) against an OpenAI-compatible endpoint (LocalAI). Extracting generation into its own service raises where this configuration lives and whether it should grow into something more general now that a second service exists.

## Decision

The same 3-variable model moves as-is into the Generation engine's own environment — the engine, not the ToolJet server, owns `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL` from here on. No multi-provider/BYOK abstraction is introduced; this is consistent with the map's stated Out of scope (issue #79) and is not reopened without an explicit new requirement.

## Consequences

- The ToolJet server no longer needs OpenAI-shaped env vars once the engine is live — those move to the engine's deployment (ADR-0032), and the server instead gets `GENERATION_ENGINE_URL` (ADR-0032).
- Switching LLM provider/model only requires touching the engine's environment, not server config or code.
- Multi-provider support, if ever needed, is a new decision, not an extension of this one.

**Superseded 2026-09-01, same day, after ticket audit:** the fork had already shipped multi-provider/BYOK (#59, org-key + provider factory, closed 2026-08-30) before this ADR was written, and #65 (admin UI for it) was open and in progress. Rejecting BYOK here would have discarded shipped, wanted functionality. See ADR-0035.
