# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo context

This is `HateTM/ToolJet`, a fork of the ToolJet CE (open-source) low-code platform, customized to add:
- **Full Russian localization** — `frontend/assets/translations/ru.json`, kept deep-synced key-for-key with `en.json`.
- **AI Builder** — an EE-style AI app/query builder implemented directly in this CE branch (`server/src/modules/ai/`, `frontend/src/modules/AiBuilder/`), backed by an OpenAI-compatible endpoint (self-hosted LocalAI).
- **Custom production build** — `docker/ce-production.Dockerfile` → image `tooljet-ce:local`, deployed self-hosted.

Remotes: `origin` = this fork (`HateTM/ToolJet`), `upstream` = `https://github.com/ToolJet/ToolJet.git`. Working branch is `main` (upstream's default branch is `develop`; this fork tracks `main`).

`server/ee/` and `frontend/ee/` are git submodules (`ee-server`, `ee-frontend`) and are **empty/uncloned** in this fork — this is CE-only. Edition-gated code checks `TOOLJET_EDITION` (`ce` / `ee` / `cloud`) at runtime via `server/src/helpers/edition.helper.ts`; don't assume EE modules are present.

CodeGraph index is available at `.codegraph` — use `codegraph_explore` before grepping/reading files to locate or understand code.

## Agent skills (from AGENTS.md)

- **Issue tracker**: GitHub issues on the fork (`origin`), via `gh issue create/view/edit/close`. See `docs/agents/issue-tracker.md`.
- **Triage labels**: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- **Domain docs**: read the root `CONTEXT.md` (the AI Builder's ubiquitous language) and the relevant entries in `docs/adr/` before exploring an area. Both exist and are maintained. See `docs/agents/domain.md`.
- **Working a ticket**: the loop from picking up an issue to seeing it close — branching, TDD seams, which checks lie about what, review, ADRs, merge. See `docs/agents/ticket-workflow.md`.

## Architecture

Monorepo with three independently-versioned npm workspaces plus a plugin system, orchestrated by the root `package.json`:

- **`server/`** — NestJS (TypeScript) backend. Entry point `server/src/main.ts`. Feature modules live under `server/src/modules/<name>/` (each typically has `module.ts`, `controller.ts`, `service.ts`, `repositories/`). Notable modules: `app` (bootstrap/global filters/interceptors), `casl` + `ability` (permission/RBAC engine), `ai` (AI Builder backend), `data-sources`/`data-queries`/`plugins` (query engine integration), `organizations`/`group-permissions`/`roles`, `git-sync`/`platform-git-sync`, `licensing`. Uses TypeORM (migrations in `db:migrate`), Redis (BullMQ for background jobs, `background-processor`/`bullmq-metrics`), PostgREST as a sidecar (see `docker-compose.yaml`), OpenTelemetry tracing (`otel/tracing`, imported first in `main.ts`).
- **`frontend/`** — React app bundled with Webpack (not Vite/CRA). Two coexisting structures: legacy feature folders at `frontend/src/AppBuilder/`, `HomePage/`, etc., and a newer `frontend/src/modules/` tree (`Appbuilder`, `AiBuilder`, `dataSources`, `workflows`, ...) — check which one owns a feature before adding code to either. State: **Zustand + Immer only** (no Redux/MobX/Recoil); use `shallow` comparisons when selecting objects/arrays from `useStore`. Styling: **Tailwind with a mandatory `tw-` prefix** (unprefixed Tailwind is treated as a bug) plus legacy `react-bootstrap` (don't extend it) — never hardcode hex/rgb colors, use CSS variable tokens (`tw-text-default`, `var(--text-default)`); tokens defined in `frontend/src/_styles/designtheme.scss` + `frontend/tailwind.config.js`. Reusable primitives live in `frontend/src/_ui/` (50+ components, check before adding new ones) composed over Radix UI. Path alias `@/` → `frontend/src/`. Icons: Tabler (`@tabler/icons-react`) or Lucide (`lucide-react`) only.
- **`plugins/`** — Lerna-managed package of ~49 data source connectors (`plugins/packages/<name>/`, e.g. `postgresql`, `restapi`, `bigquery`, `airtable`, ...), each with its own `lib/`, `__tests__/`, `package.json`. Built independently and installed into the server at build/runtime (`db:setup`/`plugins:install`).
- **`cli/`** — `@tooljet/cli`, for scaffolding/building third-party plugins.
- **`cypress-tests/`** — E2E suite, split into multiple Cypress configs (`cypress-appbuilder`, `cypress-ee-platform`, `cypress-gitsync`, `cypress-marketplace`, `cypress-platform`).

Edition gating (`ce`/`ee`/`cloud`) runs through most modules — check `TOOLJET_EDITION` handling and `getEditionPriority`/`isEditionDowngrade` in `edition.helper.ts` before assuming a feature is CE-available.

## Common commands

Run from repo root unless noted. Node `22.15.1`, npm `10.9.2` (see `engines` in `package.json`).

**Full stack (Docker dev, recommended)**:
```
docker compose up   # postgres, redis, postgrest, plugins, client (:8082), server (:3000)
```

**Build** (root orchestrates plugins → frontend → server):
```
npm run build                # full production build
npm run build:frontend       # frontend only
npm run build:server         # server only
npm run build:plugins:prod   # plugins only
```

**Database** (from root, proxies into `server/`):
```
npm run db:setup      # create + migrate
npm run db:migrate
npm run db:seed
npm run db:reset       # drop + setup
```

**Server** (`cd server`):
```
npm run start:dev              # NestJS watch mode
npm run lint                   # eslint .
npm test                       # jest, all specs
npm test -- path/to.spec.ts    # single file
npm run test:e2e               # bash scripts/run-e2e.sh
npm run test:cov
```

**Frontend** (`cd frontend`):
```
npm start                                  # webpack dev server, :8082
npm run lint                               # eslint src
npm run typecheck                          # tsc --noEmit
npm test                                   # jest
npm test -- ComponentName                  # single file/pattern
npm run storybook                          # component storybook, :6006
```

**Plugins** (`cd plugins`, Lerna-managed):
```
npm install
npm run build
```

**Cypress E2E** (`cd cypress-tests`) — see individual `cypress-*.config.js` per suite area.

## Conventions to follow (from `.github/copilot-instructions.md`)

- Tailwind classes **must** use the `tw-` prefix; unprefixed Tailwind is a bug.
- Never hardcode hex/rgb/hsl colors — use design token classes or CSS vars.
- Prefer Tailwind over `react-bootstrap` for new code; don't extend legacy Bootstrap usage.
- Functional components + hooks only, no class components.
- Component file shape: `ComponentName/index.js` (+ optional `ComponentName.jsx`, `style.scss`).
- Check `frontend/src/_ui/` before creating a new UI component.
- Use the `@/` import alias, not deep relative paths (`../../..`).
- Zustand + Immer for state; always use `shallow` when selecting objects/arrays.
- No new icon packages — Tabler or Lucide only.
- No API keys/secrets in client-side code.
- Backend: parameterized queries only — never concatenate user input into SQL.

## Branching / commits (this fork)

- Base/working branch is `main`.
- Prefixes: `feature/<issue-id>-<short-name>`, `fix/<issue-id>-<short-name>`, `docs/<short-name>`, `chore/<short-name>`.
- Commit messages: short, imperative (`Add chart export option`, not `Added...`). Reference `Closes #<id>` when applicable.
- Issues are tracked on the fork (`origin`), not upstream — use `gh issue ...` against `HateTM/ToolJet`.
