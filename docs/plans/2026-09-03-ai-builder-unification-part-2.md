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

### Task 6: Деплой движка на TrueNAS ✅ done (2026-09-04, infra-only, SSH `truenas_admin@10.10.20.2`)
**Files:** `deploy/truenas/generation-engine.compose.yaml`, `deploy/truenas/smoke-test-generation-engine.sh` (ADR-0032), `generation-engine/Dockerfile` (fix).

> **Status note (2026-09-04):** SSH access to the TrueNAS box was provided this session,
> so this got done live rather than staying a manual-only task.
>
> Fixed a real bug found along the way: `generation-engine/Dockerfile`'s `npm ci` /
> `npm ci --omit=dev` failed inside `node:22.15.1-slim` with `ERESOLVE` — the repo-root
> `.npmrc` (`legacy-peer-deps=true`) isn't copied into the engine's build context, so the
> flag that makes `npm ci` succeed locally wasn't applied in Docker. Added
> `--legacy-peer-deps` to both `npm ci` invocations in the Dockerfile; image now builds
> clean (`docker build -t generation-engine:local generation-engine/`).
>
> Deploy path taken (both hosts `x86_64`, no rebuild-for-arch needed):
> `docker save generation-engine:local | ssh ... 'sudo docker load'`, then
> `docker network create --driver bridge tooljet-shared` (previously didn't exist), then
> `midclt call -j app.create` with `custom_app: true` and the compose file's service block
> as `custom_compose_config_string` — installed as a properly TrueNAS-managed custom app
> (not a bare `docker compose up`, which is how the pre-existing orphan below was made).
>
> **Divergence from CLAUDE.md's Deployment Context, surfaced not silently absorbed:** the
> TrueNAS box has **no `tooljet-ce:local` production app** matching the documented
> "port 8083, `LANGUAGE=ru`" setup. The only related container found was an *orphaned*
> `ix-tooljet-min-tooljet-1` (vanilla `tooljet/tooljet-ce:latest`, crash-looping on
> `wait-for-it.sh` — missing host:port env, and untracked by `midclt app.query`, i.e. not
> a real TrueNAS-managed app). Left untouched — out of Task 6's scope and too destructive
> to touch on an ambiguous mandate. **This means Task 7's `GENERATION_ENGINE_URL` wiring
> to a live server is unverified** — only the engine's own reachability is proven here.
> Stubbing/rebuilding the actual prod ToolJet app is a separate, undocumented project.
>
> Smoke test run **verbatim** (script copied to `/tmp/smoke-test.sh` on the TrueNAS host,
> executed inside a throwaway `curlimages/curl` container on the `tooljet-shared` network
> since no host port is published, per ADR-0032):
> ```
> $ docker run --rm --network tooljet-shared -e GENERATION_ENGINE_URL=http://generation-engine:3100 \
>     -v /tmp/smoke-test.sh:/smoke-test.sh curlimages/curl:latest sh /smoke-test.sh
> Checking http://generation-engine:3100/health ...
> OK: {"status":"ok"}
> ```

- [x] Развернуть `generation-engine` как TrueNAS custom app по существующему compose-файлу (ADR-0032): shared `external: true` docker network (`tooljet-shared`, created), без публикации хост-порта.
- [x] Прогнать `smoke-test-generation-engine.sh` против живого деплоя — прошёл (вывод выше).
- [x] Rollback-план не требуется (как и было зафиксировано в Global Constraints) — до Task 7 недоступность движка эквивалентна текущему silent fallback.
- [x] Инфраструктурный деплой + фикс `generation-engine/Dockerfile` (`--legacy-peer-deps`) — код-фикс идёт отдельным коммитом/PR; факт деплоя и вывод smoke-теста зафиксированы здесь.

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

### Task 7: Hard switch — удаление fallback (ADR-0052) ✅ done (2026-09-04)
**Files:** `server/src/modules/ai/service.ts` (`sendUserMessage`'s `streamPrdText`, `generateStepPlan`), `server/test/modules/ai/unit/*.spec.ts`.

> **Status note (2026-09-04):** Task 6's smoke test passed, so this was picked up in the
> same session. Two of this task's own file-list premises turned out false — corrections
> below, same pattern as Task 8a's refusal.
>
> **`regenerateAiMessage` was never in scope — it never called the engine.** Only two
> `isConfigured()` soft-gates existed in the code (`streamPrdText` for `sendUserMessage`,
> and `generateStepPlan`), not three. `regenerateAiMessage`'s PRD-regeneration path has
> always called `aiUtilService.AIGatewayGenerate` unconditionally (confirmed via
> `git log` — the engine was never wired into it since ticket #131). There was no
> fallback there to remove; wiring it into the engine now would be new feature work, not
> a hard switch, so it was left untouched.
>
> **`prompt-library/` must NOT be deleted.** It's still a live import for unrelated
> features: `generateQuery` (`service.ts:47`) and `updateQuery`
> (`services/query-update.ts:4`). Only `STEP_PLAN_SYSTEM_PROMPT` and
> `proposeStepPlanTool` — both defined directly in `service.ts`, not in
> `prompt-library/` — were actually dead once `generateStepPlan`'s in-process branch was
> removed, and those two (plus their now-orphaned `STEP_TYPES`/`seedRowObject`/
> `seedRowsObject` helpers) were deleted. `PRD_SYSTEM_PROMPT` also survives — it's still
> read by `buildPrdMessages`, which `regenerateAiMessage` still uses.
>
> **Implementation:** `streamPrdText` and `generateStepPlan` now throw
> `ServiceUnavailableException` (missing `GENERATION_ENGINE_URL`, or any engine-path
> failure) instead of falling back — no new plumbing needed, both callers' existing
> generic `catch` blocks already turn a thrown exception into an SSE `error` event
> (`approvePrd`) or propagate it as a real HTTP error (`previewPlan`).
>
> **Two consequences surfaced, not silently absorbed:**
> 1. Dropping the in-process fallback also dropped `usageSink` — the engine's `streamPrd`
>    never surfaced token usage (ADR-0027), so every PRD-conversation message now
>    persists `metadata: undefined`. `getThreadTokenUsage` sums nothing for these going
>    forward. Follows directly from the engine's contract, not a bug, but a named
>    behavior change ADR-0052 didn't call out.
> 2. ADR-0018's planner-prompt guidance ("an external source can never receive a
>    CreateTable") has no equivalent anymore: `generateStepPlan`'s engine call
>    (`generateSteps(prd, undefined, componentIndex, organizationId)`) doesn't pass
>    `dataSources` at all, so there's no prompt left to carry that hint. The
>    execution-time safety net (`approvePrd`'s `filteredSteps`, stripping `CreateTable`
>    when `dataSourceId` is set) still enforces the constraint independently, so behavior
>    is unaffected — but the planner is no longer told about it in advance. Test coverage
>    for the removed prompt guidance was deleted rather than faked.
>
> Test suite: ~50 tests across `service.spec.ts`/`ai.service.spec.ts`/
> `mention-references.spec.ts` assumed the removed fallback as their default world
> (`generationEngineClient`/`generationEnginePipelineClient` now default to configured);
> converted to exercise the engine path instead. `npm run test:ai` — 588/588 green (run
> against Node 24, this fork's actual Node version — see the `sanitize-html` fix below).
>
> **Unrelated bug fixed along the way:** `jest.ai-unit.config.js` couldn't run at all
> under Node 24 — `sanitize-html`'s `htmlparser2` dependency ships an ESM-only dist that
> `require()` chokes on. Mocked offline (`test/__mock__/sanitize-html.ts`), same pattern
> as the existing `isolated-vm`/`got` mocks; the AI Builder specs never exercised real
> HTML sanitization anyway.

- [x] Один PR на все три call-сайта — фактически два реальных call-сайта (`sendUserMessage`, `generateStepPlan`); `regenerateAiMessage` не было — см. заметку выше.
- [x] Отсутствие `GENERATION_ENGINE_URL` → fail-fast `ServiceUnavailableException` (не silent fallback).
- [x] Удалить `STEP_PLAN_SYSTEM_PROMPT`, `proposeStepPlanTool` (мёртвый код после удаления in-process ветки). `prompt-library/` и `PRD_SYSTEM_PROMPT` **не удалены** — оба всё ещё живые импорты (см. заметку выше).
- [x] Гейт по ADR-0052 re-entry condition: Task 5 + Task 6 оба закрыты и подтверждены — выполнено.
- [x] Гейт: `npm run test:ai` — 588/588 зелёных.
- [x] Commit: `feat(ai): hard switch to generation engine, remove in-process prompt fallback`

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
> run-time step list) but **still not executed**. Structurally the mocking approach is
> sound (intercepts the `fetch` transport `fetchEventSource` uses). A later session with
> Docker available tried to bring up the local dev stack (`docker compose up`) to actually
> run it, and hit a pre-existing, unrelated blocker: the `server` container crashes on
> startup with `Cannot find module 'pino-http'` — `nestjs-pino` requires `pino`/`pino-http`
> as peers but neither is declared in `server/package.json`/`package-lock.json`. Fixing it
> safely requires a checkout with the full `plugins/packages/` set (a lockfile regen in a
> partial worktree corrupts the `@tooljet-plugins/*` section) — tracked as
> [HateTM/ToolJet#166](https://github.com/HateTM/ToolJet/issues/166). Run the spec against
> a live stack once #166 is resolved, before fully trusting it:
> `npx cypress run --config-file cypress-appbuilder.config.js --spec cypress/e2e/happyPath/platform/commonTestcases/apps/aiBuilderConfirmationBanner.cy.js`

- [x] Inline-баннер в списке шагов для состояния `awaiting_confirmation` — не блокирующая модалка. Покрывает и `CreateTable`, и (по построению, на случай появления) `UpdateTable`.
- [x] Cypress: только сценарий подтверждения (banner → confirm/reject) — написан, не запущен (см. статус выше).
- [x] Гейт: `npm run typecheck` зелёный. Cypress — не запущен в этой сессии.
- [x] Commit: `feat(frontend): awaiting_confirmation banner for step list, Cypress coverage`

## Явно вне скоупа
Workflows (ADR-0047, полная реализация: node-graph editor, execution engine, webhooks, schedules, Python executor) — отдельная, ещё не спроектированная Часть 3.
