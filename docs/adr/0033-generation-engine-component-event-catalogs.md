# ADR-0033: Component/event catalogs rebuilt from scratch for the Generation engine

Date: 2026-09-01
Ticket: #86 (fork component/event catalog vs. EE reference)
Status: Accepted

## Context

Auditing the fork's current catalogs against the EE reference found the fork's component catalog (`server/src/modules/ai/helpers/componentsMeta.json`) is a narrow post-hoc validator covering 11 widgets, and the fork has **no event catalog at all** — event generation is not LLM-driven; the one event the fork ever emits is hardcoded in `agents.service.ts`. Both are far short of what per-entity generation (ADR-0028) needs once the engine is expected to reason about component and event vocabularies the way EE does.

## Decision

The Generation engine builds **both catalogs from scratch**, modeled on the EE reference's structure, rather than extending or reusing the fork's existing `componentsMeta.json` or hardcoded event. This applies to both the component catalog and the (currently nonexistent) event catalog.

## Consequences

- `componentsMeta.json` and the `agents.service.ts` hardcoded event are not carried into the engine as a starting point — they get superseded, not migrated.
- Per-entity generation (ADR-0028) and the tool definitions it exposes to the LLM depend on these catalogs existing before that stage can be implemented meaningfully.
- No proprietary EE code or prompts are reused, only the catalogs' architectural shape (per `ee-extract/analysis/*`, architecture-only reference).
