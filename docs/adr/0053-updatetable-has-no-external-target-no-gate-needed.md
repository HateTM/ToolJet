---
status: accepted
---

# `UpdateTable` has no external-target capability today; Task 8a's premise is false, no gate built

## Context

Part 2's plan (`docs/plans/2026-09-03-ai-builder-unification-part-2.md`, Task 8a) asserted:
"`UpdateTable` выполняет DDL против внешних Postgres-источников без гейта
`awaiting_confirmation` вообще (в отличие от `CreateTable`)", and asked for a
`resolveUpdateTableTarget` + confirmation gate mirroring `CreateTable`'s (ADR-0042/0044).

Tracing the actual execution path (`server/src/modules/ai/service.ts`) shows this premise
is false:

- `step.targetDataSourceId` is only ever computed and persisted for steps where
  `proposed.type === "CreateTable"` (`persistProposedSteps`, the `plannedTable` /
  `targetResolution` ternaries) — an `UpdateTable` step can never carry a
  `targetDataSourceId`.
- `executeUpdateTableStep` never reads `step.targetDataSourceId` at all.
- `AgentsService.UpdateTable` / `ViewTable` both call
  `tooljetDbTableOperationsService.perform(...)` unconditionally — there is no
  `UpdateExternalTable`/`ViewExternalTable` method, unlike `CreateExternalTable`/
  `SeedExternalTable` which back `CreateTable`'s external path.
- `updateTableTool`'s own description says "Replace an existing **ToolJet DB** table's
  column definition" — the LLM path was never told external targets exist either.

`UpdateTable` is, today, structurally incapable of touching a connected external
PostgreSQL source. There is no confirmation gate to add because there is nothing to gate.

## Decision

Do not build `resolveUpdateTableTarget`, an `UpdateExternalTable` DDL path, or a
confirmation gate for a capability that does not exist. Adding that machinery now would
be a new feature (external-target `UpdateTable`) built to satisfy a plan line that
misdescribed the current system, not a security fix — no ADR authorizes external-target
`UpdateTable` the way ADR-0042 authorizes it for `CreateTable`.

Task 8a is closed with this explicit refusal, per the plan's own "«Ждёт задачу» запрещена:
незавершённость — тикет или явный отказ в ADR" clause. No branch, no PR, no code change.

## Future work

If external-target `UpdateTable` is ever wanted, it needs its own ADR (mirroring
ADR-0042's shape: target resolution at plan time, an `UpdateExternalTable`/`ViewExternalTable`
pair building `ALTER TABLE` DDL against the connected source, wired through
`persistProposedSteps` the same way `CreateTable`'s `targetResolution` is) — at which point
the confirmation gate this task asked for becomes a real, small addition on top of that,
reusing `awaitExternalTableConfirmation`'s existing generic shape.

## Consequences

- Task 8b's frontend banner (keyed on `step.status === 'awaiting_confirmation'`) still
  covers `UpdateTable` by construction the moment external-target support is ever added —
  no frontend rework needed then.
- No behavior change in this repo from this ADR; it only documents why Task 8a produced
  no diff.
