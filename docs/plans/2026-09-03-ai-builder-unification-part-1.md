# Унификация AI Builder: модернизация 2026, дедупликация, hard switch, полный фронтенд (Часть 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Модернизировать стэк до актуальных версий 2026, свести дубликаты AI Builder к единой реализации (владелец — generation engine), удалить in-process fallback после деплоя движка, довести фронтенд полностью.

**Architecture:** Движок — единственный владелец генерирующих промптов и каталогов; сервер — оркестрация, валидация, исполнение. Порядок: документация → модернизация → политика (ADR-0050) → гварды → [Часть 2:] паритет каталога → деплой → удаление fallback → фронтенд. Часть 1 не меняет живое поведение; Часть 2 меняет (детализируется отдельным планом после Части 1).

**Tech Stack:** NestJS 11→12 / TS 5 / TypeORM 0.3→1.0 (server), Fastify + Vercel AI SDK 4→6 (engine), React 18→19 (frontend), Jest, Cypress, TrueNAS custom app.

## Global Constraints
- Каждая задача (и под-шаг модернизации) — отдельный PR squash в main; ребейз от свежего origin/main.
- «Готово = проверено» (verification-before-completion): каждая задача закрывается выводом тестов/команды.
- Гейты: engine `npm test` (baseline 152/152), server `npm run test:ai` (6 падений ai-feasibility — baseline), frontend `npm run typecheck` + smoke `npm test`, после фронтенда — Cypress.
- Принимаемое следствие модернизации: расхождение с upstream CE растёт (ADR-0046-порядок мерджа апстрима применяется до, не после).
- Скоуп модернизации: engine, server, frontend, cypress-tests, root-пины (Node/npm/.nvmrc). plugins/cli/marketplace/docs — только если сломаются гейты.
- Применяемые skills: context7 + ai-sdk (доки AI SDK 6), nestjs-best-practices, vercel-react-best-practices + frontend-design (Task 8), test-driven-development (Task 4), subagent-driven-development + code-review (субагент на задачу, ревью между задачами), prod-status (Task 6), resolving-merge-conflicts.
- «Ждёт задачу» запрещена: незавершённость — тикет или явный отказ в ADR.
- Политика портирования (2026-09-03): расхождения сводим к единой реализации; старое удаляется сразу после реализации и тестов нового; EE-модули — сразу полностью.

## Задачи

### Task 1: Документационный аудит — обновить всё, мёртвое удалить
**Files:** `docs/plans/2026-09-02-ai-builder-expansion.md` (delete), `CONTEXT.md` (~:125-140 glossary), `AGENTS.md` (навигация AI Builder), `server/src/modules/ai/prompt-library/README.md` (пометка о судьбе), ADR-баннеры готовятся здесь, коммитятся в Task 3.

- [x] Удалить `docs/plans/2026-09-02-ai-builder-expansion.md` (реализован полностью; ПРЕ-АВТОРИЗОВАНО пользователем).
- [x] Обновить CONTEXT.md glossary (Generation engine / catalogs / Pipeline stage — актуальное состояние: 3 роута, 8 стадий, проксирование планирования ADR-0048).
- [x] Обновить AGENTS.md (секция AI Builder: движок как владелец генерирующих промптов).
- [x] README prompt-library: пометка о судьбе (удаление в hard-switch PR, 2 подключённых файла инлайнятся).
- [x] Проверка: `grep -rn "ждёт задачу\|TBD" docs/` — ноль вживых документах.
- [x] Commit: `docs: audit AI Builder docs — drop implemented status tracker, refresh engine glossary`

### Task 2: Модернизация стэка до актуального 2026
Актуальные цели: **AI SDK 6.x + zod 4** (движок), **NestJS 12** (ESM-ready, docs.nestjs.com/migration-guide), **TypeORM 1.0** (deprecated API удалены, ECMA 2023), **React 19.2**, свежие Jest/Cypress/TS. Под-шаги — отдельные PR, порядок: движок → server → frontend → tooling.

**2a. Engine: AI SDK 4.3.19 → 6.x** (`generation-engine/package.json`, `src/pipeline/llm-deps.ts`, `step-generation.ts`, `per-entity.ts`, `prd.ts`, `routes/*`, mock-LLM тесты)
- [ ] context7/`node_modules/ai/docs/` — сверить API (renamed: parameters→inputSchema и др. по references/common-errors.md).
- [ ] `npm install ai@latest @ai-sdk/{openai,anthropic,google}@latest zod@latest`.
- [ ] Ручной `JSON.parse` payload'ов → `generateObject` + zod-схема per step type.
- [ ] `abortSignal` из HTTP-запроса через все LLM-вызовы.
- [ ] `experimental_telemetry` + OTel: token usage структурированно в ответе.
- [ ] `APICallError.isRetryable` → 503 vs 400.
- [ ] Гейт: engine-тесты 152+ зелёные. Commit: `feat(engine): AI SDK 6, structured outputs, abort propagation, telemetry`

**2b. Server: NestJS 11→12, TypeORM 0.3→1.0, TS latest**
- [ ] TS + типы → чистая `nest build`.
- [ ] TypeORM 1.0 upgrade path: deprecated-API аудит по `server/src/entities`, `repositories`, data-migrations; гейт — DB-backed suite (baseline 457/457) + `test:ai`.
- [ ] NestJS 12: ESM-совместимость, compat @nestjs/{typeorm,throttler,swagger,jwt,config}, BullMQ, platform-ws; гейты — `test:ai` + выборочный e2e smoke.
- [ ] Commit: `chore(server): NestJS 12, TypeORM 1.0, TS latest`

**2c. Frontend: React 18→19**
- [ ] Compat-аудит: legacy react-bootstrap, PropType, findDOMNode; codemod'ы React 19.
- [ ] react/react-dom + @types, webpack/babel; гейт: `npm run typecheck` + smoke `npm test` + storybook.
- [ ] Блокер (react-bootstrap несовместим) → решение в ADR-0051, не «ждёт задачу».
- [ ] Commit: `chore(frontend): React 19`

**2d. Tooling:** Cypress latest, root dev-deps, `.nvmrc`/npm-пины — одним PR `chore: tooling 2026`.

### Task 3: ADR-0050 — hard switch, отмена silent fallback
**Files:** Create `docs/adr/0050-hard-switch-to-generation-engine.md`; modify `0036`, `0048`, `CONTEXT.md`.
- [ ] Decision: после деплоя и паритет-проверки fallback удаляется; отсутствие `GENERATION_ENGINE_URL` = fail-fast `ServiceUnavailableException`; Learn/fix-with-AI/copilot не затрагиваются; ADR-0036 d1 и ADR-0048 d5 — Superseded.
- [ ] Баннеры в 0036/0048; термины `Prompt owner`, `Hard switch` в CONTEXT.md.
- [ ] Commit: `docs(adr): ADR-0050 hard switch to generation engine, supersede silent fallback`

### Task 4: Двусторонние sync-гварды (TDD: сначала падающий тест)
**Files:** Create `server/test/modules/ai/unit/engine-contract-sync.spec.ts`, `generation-engine/test/fork-contract-sync.test.ts`; modify `generation-engine/test/catalogs/component-catalog.test.ts`, `generation-engine/src/pipeline/types.ts:99-109`.
Механика: TS-импорт между пакетами невозможен (typeorm, алиасы) — читаем чужой файл как текст (`fs.readFileSync` + regex).

- [ ] Падающий server-тест: парсит `STEP_TYPES` из `generation-engine/src/pipeline/types.ts`, сверяет с entity `StepType` (`step.entity.ts:14-24`, 10 членов). FAIL: в движке 9, нет `UpdateTable`.
- [ ] Фикс: `'UpdateTable'` в engine `STEP_TYPES` (промпт и per-entity роутинг уже есть, ADR-0041); doc-comment :93-98.
- [ ] Зеркальный engine-тест: парсит union из `step.entity.ts`.
- [ ] Server-тест: парсит `LlmProvider` из `generation-engine/src/config/llm.ts:10`, сверяет с `constants/llm.ts:8`.
- [ ] Engine `component-catalog.test.ts`: hardcoded `FORK_COMPONENT_SET` → чтение `componentsMeta.json` (ключи) — упадёт (11 vs 36), зеленеет в Части 2 (Task 5).
- [ ] Commit: `test: bidirectional fork↔engine contract guards; add UpdateTable to engine STEP_TYPES`

## Часть 2 (отдельный план после Части 1)
Task 5: каталог движка 11→36 (ADR-0026 метод). Task 6: деплой TrueNAS (ADR-0032) + prod-status. Task 7: hard switch — удаление fallback (`generateStepPlan` :2211-2264, `streamPrdText` :4329-4342, `regenerateAiMessage` :4985), fail-fast, удаление `prompt-library/`, `PRD_SYSTEM_PROMPT`/`STEP_PLAN_SYSTEM_PROMPT`/`proposeStepPlanTool`. Task 8: фронтенд — `step-awaiting-confirmation` UI, Cypress E2E AI-потоки, workflows до полной реализации (ADR-0047).
