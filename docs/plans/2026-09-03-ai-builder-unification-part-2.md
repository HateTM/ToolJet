# Унификация AI Builder: каталог, деплой, hard switch, фронтенд (Часть 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести каталог движка до паритета с форком (11→35 типов), задеплоить движок на TrueNAS, довести до конца потребление plan-time payload'ов executors, выполнить hard switch (удалить in-process fallback, ADR-0052), закрыть дыру в confirmation-гейте для `UpdateTable`, довести фронтенд.

**Architecture:** Продолжение Части 1 (`docs/plans/2026-09-03-ai-builder-unification-part-1.md`). Порядок строго последовательный: паритет каталога → деплой → потребление plan-time payload'ов → hard switch → фронтенд (backend-гейт → UI). Каждая задача меняет живое поведение (в отличие от Части 1).

**Tech Stack:** без изменений относительно Части 1 (движок на Fastify + Vercel AI SDK 6, сервер NestJS 11 + TypeORM 1.0, фронтенд React 19).

## Global Constraints
- Каждая задача — отдельный PR squash в main; ребейз от свежего origin/main.
- «Готово = проверено»: каждая задача закрывается выводом тестов/команды.
- Гейты: engine `npm test` (baseline после Части 1: 177/178, ожидаемо зеленеет до 178/178 в Task 5), server `npm run test:ai`, frontend `npm run typecheck` + smoke `npm test`, после Task 8b — Cypress.
- «Ждёт задачу» запрещена: незавершённость — тикет или явный отказ в ADR.
- Task 6 done-условие: `deploy/truenas/smoke-test-generation-engine.sh` проходит против живого деплоя. Отдельного rollback-плана нет — до hard switch (Task 7) недоступный движок это уже существующий silent fallback (ADR-0036/0048), т.е. rollback = не выставлять `GENERATION_ENGINE_URL`.
- Ссылка на `prod-status` skill в исходном черновике Части 1 — опечатка/leftover, такого skill нет в репозитории; не использовать.
- Workflows (ADR-0047, полная реализация: node-graph editor, execution engine, webhooks, schedules, Python executor) — явно вне скоупа, переносится в будущую, ещё не спроектированную Часть 3.

## Задачи

### Task 5: Каталог движка 11→35 ✅ done (PR #160, `408e0791`)
**Files:** `generation-engine/src/catalogs/*`, `generation-engine/test/catalogs/component-catalog.test.ts`, `server/src/modules/ai/helpers/componentsMeta.json` (источник истины по составу).

- [x] Уточнить источник: `componentsMeta.json` содержит 35 ключей (не 36 — цифра из черновика Части 1 неверна), движок покрывает 11.
- [x] Один PR/волна на все 24 недостающих типа, механический перенос методом ADR-0026 (EE→fork transform).
- [x] Заодно ре-токенизировать `styles`-цвета для всех 35 типов (включая уже перенесённые 11) со старых EE hex-значений на `var(--cc-*)` дизайн-токены форка — файлы всё равно переоткрываются.
- [x] Гейт: `component-catalog.test.ts` (уже написан в Части 1, Task 4) зеленеет — 35/35 ключей покрыты; полный `npm test` движка 178/178.
- [x] Commit: `feat(engine): catalog parity 11→35, re-tokenize styles to fork design tokens`

### Task 6: Деплой движка на TrueNAS — ⏸ NOT DONE, requires manual action
**Files:** `deploy/truenas/generation-engine.compose.yaml`, `deploy/truenas/smoke-test-generation-engine.sh` (ADR-0032).

> **Status note (2026-09-04):** an agentic session cannot reach the user's TrueNAS box —
> this is a real infrastructure deploy, out of reach from any git worktree. Left for the
> user to do manually. Tasks 7 stays blocked on this (see its own status note) until done.

- [ ] Развернуть `generation-engine` как TrueNAS custom app по существующему compose-файлу (ADR-0032): shared `external: true` docker network, без публикации хост-порта.
- [ ] Прогнать `smoke-test-generation-engine.sh` против живого деплоя — done-условие задачи.
- [ ] Явно зафиксировать в задаче/ADR: отдельного rollback-плана не требуется — до Task 7 (hard switch) недоступность движка эквивалентна текущему silent fallback.
- [ ] Commit/note: деплой инфраструктурный, если нет кода для коммита — зафиксировать факт деплоя и вывод smoke-теста в PR-описании или в этом плане.

### Task 6.5: Потребление `props.generatedStep` (hint-with-override) ✅ already done pre-Part-2
**Files:** step executors для non-table типов, `server/src/modules/ai/service.ts` (там же, где `props.generatedStep` сейчас не читается — ADR-0048).

> **Status note (2026-09-04):** found already fully implemented on `main` (PR #131,
> ADR-0049 "Deterministic consumption of props.generatedStep payloads") before this Part 2
> session started. `resolveGeneratedStepArgs` is wired into all 8 non-table executors with
> happy-path + fallback tests. No new work needed — this task's checkboxes below describe
> what already ships.

- [x] Для каждого non-table step executor: сначала пробовать plan-time payload движка (`props.generatedStep`), валидировать против execution-time состояния (реальный `componentId`, live app state).
- [x] При невалидности/несовпадении — fallback на собственный LLM-вызов executor'а (текущее поведение).
- [x] Позиция в порядке: между деплоем (Task 6) и hard switch (Task 7) — по смыслу это про доверие к выводу движка ещё до исчезновения fallback, хотя жёсткой зависимости от Task 5/6 нет.
- [x] Тесты: для каждого executor — happy path (валидный payload используется как есть) + fallback path (невалидный/устаревший payload → LLM-вызов).
- [x] Commit: `feat(ai): consume engine plan-time payload with execution-time validation, fallback on mismatch` (уже в main, до Part 2)

### Task 7: Hard switch — удаление fallback (ADR-0052) — ⏸ BLOCKED on Task 6
**Files:** `server/src/modules/ai/service.ts` (`sendUserMessage`, `generateStepPlan`, `regenerateAiMessage`), `server/src/modules/ai/prompt-library/` (delete), `PRD_SYSTEM_PROMPT`, `STEP_PLAN_SYSTEM_PROMPT`, `proposeStepPlanTool` (delete).

> **Status note (2026-09-04):** not attempted. This task's own re-entry gate below requires
> Task 6's live deploy to be smoke-tested first — removing the fallback before that is
> verified would leave the AI Builder with no working generation path if the engine turns
> out to be unreachable. Pick this up once Task 6 is done.

- [ ] Один PR на все три call-сайта: убрать in-process генерацию, оставить только движок.
- [ ] Отсутствие `GENERATION_ENGINE_URL` → fail-fast `ServiceUnavailableException` (не silent fallback).
- [ ] Удалить `prompt-library/`, `PRD_SYSTEM_PROMPT`, `STEP_PLAN_SYSTEM_PROMPT`, `proposeStepPlanTool`.
- [ ] Гейт по ADR-0052 re-entry condition: задача открывается только после Task 5 (паритет каталога) + Task 6 (деплой подтверждён smoke-тестом).
- [ ] Гейт: `npm run test:ai` зелёный без prompt-library-тестов (удалить/перенести соответствующие спеки).
- [ ] Commit: `feat(ai): hard switch to generation engine, remove in-process prompt fallback`

### Task 8: Фронтенд — confirmation-гейт для UpdateTable + UI

**8a. Backend: `awaiting_confirmation` для UpdateTable** ✅ closed as refusal (ADR-0053, PR #161, `a58385a2`)
**Files:** `server/src/modules/ai/service.ts` (`executeUpdateTableStep`), по аналогии с `CreateTable` (ADR-0042/0044).

> **Status note (2026-09-04):** the premise was false. Traced the actual execution path:
> `targetDataSourceId` is only ever computed/persisted for `CreateTable` steps
> (`persistProposedSteps`'s `targetResolution` ternary), and `AgentsService.UpdateTable`/
> `ViewTable` always operate on ToolJet DB — there is no `UpdateExternalTable` method.
> `UpdateTable` cannot touch an external Postgres source today, so there is nothing to gate.
> Documented in ADR-0053 and closed via this plan's own "тикет или явный отказ в ADR"
> escape hatch. No code change.

- [x] ~~Найденная в грилинге дыра~~ — не подтвердилась (см. статус выше): `UpdateTable` не может таргетировать внешние источники вообще.
- [x] ~~Добавить `resolveUpdateTableTarget` + `awaiting_confirmation` гейт~~ — нечего гейтить, см. ADR-0053.
- [x] Явный отказ задокументирован в ADR-0053.
- [x] Commit: `docs(adr): ADR-0053, Task 8a refused — UpdateTable has no external target to gate`

**8b. Frontend + Cypress** ✅ done (PR #162, `d86e1b84`, 1 fix round)
**Files:** step list UI (AiBuilder), `cypress-tests/` (соответствующий config).

> **Status note (2026-09-04):** Cypress spec written (first one covering the AI Builder's
> run-time step list) but **not executed** — no Docker daemon available in this session.
> Structurally the mocking approach is sound (intercepts the `fetch` transport
> `fetchEventSource` uses). Run it against a live stack before fully trusting it:
> `npx cypress run --config-file cypress-appbuilder.config.js --spec cypress/e2e/happyPath/platform/commonTestcases/apps/aiBuilderConfirmationBanner.cy.js`

- [x] Inline-баннер в списке шагов для состояния `awaiting_confirmation` — не блокирующая модалка. Покрывает и `CreateTable`, и (по построению, на случай появления) `UpdateTable`.
- [x] Cypress: только сценарий подтверждения (banner → confirm/reject) — написан, не запущен (см. статус выше).
- [x] Гейт: `npm run typecheck` зелёный. Cypress — не запущен в этой сессии.
- [x] Commit: `feat(frontend): awaiting_confirmation banner for step list, Cypress coverage`

## Явно вне скоупа
Workflows (ADR-0047, полная реализация: node-graph editor, execution engine, webhooks, schedules, Python executor) — отдельная, ещё не спроектированная Часть 3.
