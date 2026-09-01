# ADR-0030: Prompt library — one file per prompt, plain git versioning

Date: 2026-09-01
Ticket: #84 (storage and versioning of the Generation engine's prompt library)
Status: Accepted

## Context

The Generation engine needs a home for its prompt text as the pipeline (ADR-0028) grows past the fork's current single-prompt-per-stage approach. The EE reference container was inspected live (not just statically) to confirm its actual layout: a `prompt-library/` directory with 27 files and a single `index.ts` re-export, one file per individual prompt rather than one per pipeline stage — several prompts can belong to the same stage (e.g. per-entity-type variants within per-entity generation).

## Decision

**One file per prompt** under `prompts/*.ts`, following the EE layout confirmed against the live container, not the fork's current one-prompt-per-stage convention. Versioning is **plain git** — no separate v1/v2 prompt-versioning system, no runtime prompt registry beyond the `index.ts` export.

Prompt-quality testing is explicitly out of scope for this ADR — see ADR-0034 (ticket #87, "Generation engine testing strategy").

## Consequences

- A pipeline stage with multiple prompt variants (e.g. per entity type) gets multiple files, not one file with internal branching — keeps each prompt independently readable and diffable.
- No prompt-version rollback mechanism beyond `git revert`; acceptable given the engine is self-hosted with no external prompt-version audience.
- `index.ts` becomes the single import surface other engine code uses to reach prompts, so pipeline code never reaches into `prompts/` file paths directly.
