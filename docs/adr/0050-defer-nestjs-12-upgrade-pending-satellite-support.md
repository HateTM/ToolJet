# ADR-0050: Defer NestJS 11→12 upgrade pending satellite package support

Status: Accepted
Date: 2026-09-03

## Context

Task 2b of `docs/plans/2026-09-03-ai-builder-unification-part-1.md` modernizes
the server stack: TypeORM 0.3→1.0, then NestJS 11→12. TypeORM 1.0 is done
(commit `c8c53e0718`, gated on tsc + `test:ai`, 27/27 suites / 593/593 tests
green).

Attempting `npm install @nestjs/*@latest` for NestJS 12 surfaced four
dependencies with no `^12.0.0`-compatible release as of 2026-09-03:

| Package | Latest | Peer range on `@nestjs/core` | Used for |
|---|---|---|---|
| `@nestjs/throttler` | 6.5.0 | `^11.0.0` | rate limiting |
| `@bull-board/nestjs` | 9.6.1 | `^9.0.0 \|\| ^10.0.0 \|\| ^11.0.0` | BullMQ dashboard |
| `nestjs-otel` | 8.1.0 | `>= 11 < 12` | OpenTelemetry integration |
| `nest-winston` | 1.10.2 | `^5.0.0 \|\| ^6.6.0 \|\| ^7.0.0 \|\| ^8.0.0 \|\| ^9.0.0 \|\| ^10.0.0 \|\| ^11.0.0` | Winston logger |

`nestjs-otel`'s range is not merely unpublished — its maintainer wrote an
explicit upper bound (`< 12`) after NestJS 12 existed, i.e. a stated claim of
incompatibility, not an oversight.

## Decision

Do not force-install NestJS 12 with `--legacy-peer-deps`/`--force` over these
four peers. Two of the four (OTel, the BullMQ dashboard) sit on operationally
important paths — production observability and job-queue visibility — on a
live deployment (see project CLAUDE.md "Deployment Context"). A peer-dep
override that happens to still work at runtime today is not a substitute for
an upstream-verified compatible release; a silent break in telemetry or queue
tooling is worse than a stale major version.

This is not "ждёт задачу" (an open-ended stall forbidden by the plan's Global
Constraints) — it is the same category of decision as the anticipated
react-bootstrap/React 19 blocker the plan already reserves an ADR for
(`docs/plans/2026-09-03-ai-builder-unification-part-1.md` line ~54, Task 2c).
NestJS 11→12 is deferred, tracked here, with an explicit re-entry condition,
rather than left implicit.

`nestjs-pino` is the one exception: its latest (5.1.0) already supports
`^12.0.0`. It is *not* bumped in this pass — doing so pulls in `pino` 9→10 and
`pino-http`'s major bump for no payoff while NestJS itself stays on 11. That
bump belongs in the NestJS 12 PR, together with the other three once they
catch up.

## Re-entry condition

Re-attempt Task 2b's NestJS 11→12 step when all four blocking packages
(`@nestjs/throttler`, `@bull-board/nestjs`, `nestjs-otel`, `nest-winston`)
have published a release compatible with `@nestjs/core@^12`. Check with:

```
npm view @nestjs/throttler@latest peerDependencies
npm view @bull-board/nestjs@latest peerDependencies
npm view nestjs-otel@latest peerDependencies
npm view nest-winston@latest peerDependencies
```

## Consequences

- Task 2b closes with TypeORM 1.0 landed and NestJS 12 explicitly deferred,
  not silently dropped.
- `server/package.json` still pins `@nestjs/*` at `^11.x` and `typeorm` at
  `^1.1.1` — this mixed state (TypeORM 1.0 on NestJS 11) is intentional and
  supported: `@nestjs/typeorm@^11.0.0`'s own peer range already accepts
  `typeorm@^0.3.0 || ^1.0.0-dev`.
- Follow-on note for whoever next runs the full DB-backed suite (not run in
  this pass — see Task 2b commit): the TypeORM 1.0 codemod fixed two latent
  relation-name bugs that were silent no-ops under 0.3's looser runtime
  handling and now actually execute a join —
  `AiResponseVote` vote-fetch (`message` → `aiConversationMessage`) and
  `DataSource.findOneWithName` (`dataSourceOptions` → `dataSourceVersions`).
  Both are behavior changes `test:ai` (unit-only) can't observe; worth a
  targeted look in the DB-backed suite or a manual check of those two flows.
