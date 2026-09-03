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

### Task 5: Каталог движка 11→35
**Files:** `generation-engine/src/catalogs/*`, `generation-engine/test/catalogs/component-catalog.test.ts`, `server/src/modules/ai/helpers/componentsMeta.json` (источник истины по составу).

- [ ] Уточнить источник: `componentsMeta.json` содержит 35 ключей (не 36 — цифра из черновика Части 1 неверна), движок покрывает 11.
- [ ] Один PR/волна на все 24 недостающих типа, механический перенос методом ADR-0026 (EE→fork transform).
- [ ] Заодно ре-токенизировать `styles`-цвета для всех 35 типов (включая уже перенесённые 11) со старых EE hex-значений на `var(--cc-*)` дизайн-токены форка — файлы всё равно переоткрываются.
- [ ] Гейт: `component-catalog.test.ts` (уже написан в Части 1, Task 4) зеленеет — 35/35 ключей покрыты; полный `npm test` движка 178/178.
- [ ] Commit: `feat(engine): catalog parity 11→35, re-tokenize styles to fork design tokens`

### Task 6: Деплой движка на TrueNAS
**Files:** `deploy/truenas/generation-engine.compose.yaml`, `deploy/truenas/smoke-test-generation-engine.sh` (ADR-0032).

- [ ] Развернуть `generation-engine` как TrueNAS custom app по существующему compose-файлу (ADR-0032): shared `external: true` docker network, без публикации хост-порта.
- [ ] Прогнать `smoke-test-generation-engine.sh` против живого деплоя — done-условие задачи.
- [ ] Явно зафиксировать в задаче/ADR: отдельного rollback-плана не требуется — до Task 7 (hard switch) недоступность движка эквивалентна текущему silent fallback.
- [ ] Commit/note: деплой инфраструктурный, если нет кода для коммита — зафиксировать факт деплоя и вывод smoke-теста в PR-описании или в этом плане.

### Task 6.5: Потребление `props.generatedStep` (hint-with-override)
**Files:** step executors для non-table типов, `server/src/modules/ai/service.ts` (там же, где `props.generatedStep` сейчас не читается — ADR-0048).

- [ ] Для каждого non-table step executor: сначала пробовать plan-time payload движка (`props.generatedStep`), валидировать против execution-time состояния (реальный `componentId`, live app state).
- [ ] При невалидности/несовпадении — fallback на собственный LLM-вызов executor'а (текущее поведение).
- [ ] Позиция в порядке: между деплоем (Task 6) и hard switch (Task 7) — по смыслу это про доверие к выводу движка ещё до исчезновения fallback, хотя жёсткой зависимости от Task 5/6 нет.
- [ ] Тесты: для каждого executor — happy path (валидный payload используется как есть) + fallback path (невалидный/устаревший payload → LLM-вызов).
- [ ] Commit: `feat(ai): consume engine plan-time payload with execution-time validation, fallback on mismatch`

### Task 7: Hard switch — удаление fallback (ADR-0052)
**Files:** `server/src/modules/ai/service.ts` (`sendUserMessage`, `generateStepPlan`, `regenerateAiMessage`), `server/src/modules/ai/prompt-library/` (delete), `PRD_SYSTEM_PROMPT`, `STEP_PLAN_SYSTEM_PROMPT`, `proposeStepPlanTool` (delete).

- [ ] Один PR на все три call-сайта: убрать in-process генерацию, оставить только движок.
- [ ] Отсутствие `GENERATION_ENGINE_URL` → fail-fast `ServiceUnavailableException` (не silent fallback).
- [ ] Удалить `prompt-library/`, `PRD_SYSTEM_PROMPT`, `STEP_PLAN_SYSTEM_PROMPT`, `proposeStepPlanTool`.
- [ ] Гейт по ADR-0052 re-entry condition: задача открывается только после Task 5 (паритет каталога) + Task 6 (деплой подтверждён smoke-тестом).
- [ ] Гейт: `npm run test:ai` зелёный без prompt-library-тестов (удалить/перенести соответствующие спеки).
- [ ] Commit: `feat(ai): hard switch to generation engine, remove in-process prompt fallback`

### Task 8: Фронтенд — confirmation-гейт для UpdateTable + UI

**8a. Backend: `awaiting_confirmation` для UpdateTable**
**Files:** `server/src/modules/ai/service.ts` (`executeUpdateTableStep`), по аналогии с `CreateTable` (ADR-0042/0044).

- [ ] Найденная в грилинге дыра: `UpdateTable` выполняет DDL против внешних Postgres-источников без гейта `awaiting_confirmation` вообще (в отличие от `CreateTable`).
- [ ] Добавить `resolveUpdateTableTarget` + `awaiting_confirmation` гейт, зеркалируя механизм `CreateTable`.
- [ ] Тесты: unit на `executeUpdateTableStep` — confirmed/unconfirmed target ветки, по прецеденту существующих тестов `CreateTable`-гейта.
- [ ] Commit: `fix(ai): add awaiting_confirmation gate for UpdateTable against connected sources`

**8b. Frontend + Cypress**
**Files:** step list UI (AiBuilder), `cypress-tests/` (соответствующий config).

- [ ] Inline-баннер в списке шагов для состояния `awaiting_confirmation` — не блокирующая модалка. Покрывает и `CreateTable`, и `UpdateTable`.
- [ ] Cypress: только сценарий подтверждения (banner → confirm/reject), не полный E2E PRD→execution (уже покрыт unit/integration тестами).
- [ ] Гейт: `npm run typecheck` + Cypress зелёные.
- [ ] Commit: `feat(frontend): awaiting_confirmation banner for step list, Cypress coverage`

## Явно вне скоупа
Workflows (ADR-0047, полная реализация: node-graph editor, execution engine, webhooks, schedules, Python executor) — отдельная, ещё не спроектированная Часть 3.
