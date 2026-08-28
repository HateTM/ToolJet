# ToolJet Fork — Project Instructions

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language and Output

Think and plan in English without exposing private chain-of-thought. Reply in Russian unless the user requests another language.

Lead with the result; include only necessary details, checks, risks, or blockers. Skip introductions, restatement, repetition, and long logs.

Project: `HateTM/ToolJet` — a fork of the ToolJet CE (open-source) low-code platform, adding full Russian localization, an in-tree AI Builder (no EE dependency), and a custom production Docker build. Remotes: `origin` = this fork, `upstream` = `https://github.com/ToolJet/ToolJet.git`. Working branch is `main` (upstream default is `develop`).

## Project Index

- `server/` — NestJS backend; feature modules under `server/src/modules/<name>/` (`module.ts`/`controller.ts`/`service.ts`/`repositories/`). AI Builder backend: `server/src/modules/ai/`.
- `frontend/` — React/Webpack; legacy features in `frontend/src/AppBuilder/`, newer ones in `frontend/src/modules/` (check both before adding code). AI Builder UI: `frontend/src/modules/AiBuilder/`. Shared primitives: `frontend/src/_ui/`.
- `plugins/packages/` — Lerna-managed data source connectors, one dir per connector.
- `cypress-tests/` — E2E, split by `cypress-*.config.js`.
- `frontend/assets/translations/{en,ru}.json` — keep RU deep-synced key-for-key with EN.
- `CONTEXT.md`, `docs/adr/` — AI Builder domain language and architecture decisions; read before working in `ai`/`AiBuilder` areas.
- `docs/agents/ticket-workflow.md` — issue-to-merge loop (branching, TDD seams, review, ADRs).
- `server/ee/`, `frontend/ee/` — git submodules, **empty in this fork**. Don't assume EE code is present; check `TOOLJET_EDITION` via `server/src/helpers/edition.helper.ts`.

## Commands

Node `22.15.1`, npm `10.9.2`. Run from repo root unless noted.

- Full stack (dev): `docker compose up` (postgres, redis, postgrest, client :8082, server :3000).
- Full build: `npm run build` (root; orchestrates plugins → frontend → server).
- DB (root, proxies into `server/`): `npm run db:setup` | `db:migrate` | `db:seed` | `db:reset`.
- Server (`cd server`): `npm run start:dev` | `npm run lint` | `npm test` | `npm test -- path/to.spec.ts` | `npm run test:e2e` | `npm run test:cov`.
- Frontend (`cd frontend`): `npm start` | `npm run lint` | `npm run typecheck` | `npm test` | `npm test -- ComponentName` | `npm run storybook`.
- Plugins (`cd plugins`): `npm install` | `npm run build`.

Known issue: server `npm test` is broken under Node 24 with the empty `@ee` submodules — use Node 22 with a minimal jest config.

## Search First, Frugal Reading, and Deny Noise

1. Exact file named → open it. Otherwise `rg` inside the routed area (module/feature dir) for symbols, errors, terms, imports.
2. Open only matches; read the relevant range plus the whole logical unit (function/component).
3. Expand only as needed to imports, callers, dependencies, tests. Don't inventory the repo.
4. `.codegraph` may exist at a level above this checkout (not always present in every worktree) — when present, prefer `codegraph_explore` over grep/read for structural questions.

Deny by default: `.env`, credentials, `node_modules`/build output/caches, `server/ee/`, `frontend/ee/` (empty), generated/minified files, full logs/DB dumps, unrelated binaries.

Example: AI Builder bug → search `server/src/modules/ai/` + `frontend/src/modules/AiBuilder/` for the symptom term → read the handler, its callers, and its test.

## Project-Specific Rules

- Tailwind: `tw-` prefix mandatory; no hardcoded hex/rgb — use tokens from `frontend/src/_styles/designtheme.scss` / `tailwind.config.js`.
- State: Zustand + Immer only, `shallow` for object/array selectors. Functional components only, no class components.
- Component file shape: `ComponentName/index.js` (+ optional `ComponentName.jsx`, `style.scss`).
- Check `frontend/src/_ui/` before adding a new UI primitive. Icons: Tabler or Lucide only. Imports via `@/` alias, not deep relative paths.
- Backend: parameterized queries only, no string-concatenated SQL. No API keys/secrets in client-side code.
- Branch prefixes: `feature/<issue-id>-<name>`, `fix/<issue-id>-<name>`, `docs/<name>`, `chore/<name>`; short imperative commit subjects; `Closes #<id>` when applicable. Issues tracked via `gh issue` against `HateTM/ToolJet` (origin, not upstream), not upstream.
- Full frontend/backend convention list: `.github/copilot-instructions.md`.

Example: adding a component → check `frontend/src/_ui/`, use `tw-` classes and tokens, no new npm icon package.
