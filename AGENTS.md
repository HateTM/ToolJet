# AGENTS.md

Working copy of **ToolJet** (CE, OSS) forked to `HateTM/ToolJet`, used to build a custom ToolJet with:
- **Full Russian localization** — `frontend/assets/translations/ru.json` is complete (all `t()` keys present, deep-synced with `en.json`)
- **AI Builder** (EE-like) — implemented in the CE branch, backed by an OpenAI-compatible endpoint (LocalAI on TrueNAS, `OPENAI_BASE_URL`, port 30286; models in `/mnt/NaS/Apps/Localai/Models`)
- **Production build** — `docker/ce-production.Dockerfile` → custom image `tooljet-ce:local`, replacing `tooljet/tooljet:ee-lts-latest` in the TrueNAS custom app (port 8083, `LANGUAGE=ru` already in env)
- **Generation engine** — separate TrueNAS custom app (`generation-engine/`, ADR-0029), reachable from `tooljet-ce:local` only over a shared `external: true` docker network, no host port published (ADR-0032, `deploy/truenas/generation-engine.compose.yaml`); `tooljet-ce:local` gets `GENERATION_ENGINE_URL` pointing at the engine's internal hostname, alongside the existing `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL` trio
- **Active plan** — [`docs/plans/2026-09-03-ai-builder-unification-part-1.md`](docs/plans/2026-09-03-ai-builder-unification-part-1.md): **Часть 1 завершена** (модернизация стэка 2026, ADR-0052 hard-switch decision, sync-гварды fork↔engine). Часть 2 (каталог движка 11→36, деплой, удаление fallback, полный фронтенд) — отдельный план, ещё не создан. Сверяться с Частью 1 при работе в области AI Builder / `generation-engine/` для контекста принятых решений; новые задачи AI Builder идут в план Части 2 после его создания.

Upstream sync: `upstream` remote = `https://github.com/ToolJet/ToolJet.git`, `origin` = fork. Codegraph index lives at `/home/hatetm/tooljet/.codegraph` (use `codegraph_explore` before reading files).

## Agent skills

### Issue tracker

Issues live as GitHub issues in the fork `HateTM/ToolJet` (origin). Use the `gh` CLI — `gh issue create` / `gh issue view <n>` / `gh issue edit` / `gh issue close`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, label string equal to role name: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. Read them before exploring; proceed silently if absent. See `docs/agents/domain.md`.

---

# ToolJet Fork Project Instructions

## Language and Output

Think and plan in English without exposing private chain-of-thought. Reply in Russian unless the user requests another language.

Lead with the result; include only necessary details, checks, risks, or blockers. Skip introductions, restatement of the request, repetition, and long logs.

Example: after a fix, report the change, the check run, and any blocker—not the debugging narrative.

## Project Index

Route each task to the narrowest source; this is an index, not documentation.

- `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md` — local agent rules, architecture, and AI Builder glossary.
- `server/` — NestJS backend (`src/modules/<name>/`, `src/helpers/edition.helper.ts`); `frontend/` — React app (`src/modules/`, `_ui/`, `assets/translations/`).
- `plugins/` — Lerna-managed data-source connectors; `cli/` — `@tooljet/cli`; `cypress-tests/` — E2E suites.
- `docs/adr/` — architecture decisions; `docs/agents/` — agent skills (issue-tracker, triage-labels, domain); `docs/plans/` — активные планы реализации (текущий — унификация AI Builder, см. ссылку в шапке).
- `docker/` — build/deploy (incl. `ce-production.Dockerfile`); `deploy/` — deployment configs.
- `.github/copilot-instructions.md` — mandatory code conventions.

Example: an AI Builder bug routes to `server/src/modules/ai/` + `frontend/src/modules/AiBuilder/` and `docs/adr/`; a localization issue routes to `frontend/assets/translations/`.

## Search First, Frugal Reading, and Deny Noise

1. Use `codegraph_explore` (or `/cg <query>`) to locate code before grepping or reading files.
2. Open an exact user-named file; otherwise search via `rg` inside the routed area.
3. Open only matches, locate the relevant symbol, and read a small range plus the complete logical unit (a function, module, or component).
4. Expand only as needed to imports, callers, dependencies, and tests; stop when evidence is sufficient.
5. Do not inventory the repository. For large files or logs, use size checks, ranges, `head`, `tail`, and filters.

Deny by default unless required: `.env`, credentials, `node_modules`, build output (`frontend/build`, `dist`), caches, generated/minified files, whole logs/databases, and unrelated binaries.

For configuration issues, inspect code, docs, and `.env.example`. Open `.env` only when essential; never expose or log secrets.

Example: edition-gating bug → search `edition.helper.ts` for `TOOLJET_EDITION` → read the function and its callers.

## Project-Specific Rules

- This is a CE-only fork: `server/ee/` and `frontend/ee/` are empty submodules; edition-gated code checks `TOOLJET_EDITION` at runtime. Never assume EE modules are present.
- Tailwind classes **must** use the `tw-` prefix; unprefixed Tailwind is a bug. Never hardcode hex/rgb/hsl colors — use design tokens (`tw-text-default`, `var(--text-default)`).
- Backend: parameterized queries only — never concatenate user input into SQL. No API keys/secrets in client-side code.
- Frontend: Zustand + Immer only (no Redux/MobX); use `shallow` when selecting objects/arrays. Functional components + hooks only. Use the `@/` import alias (not deep relative paths). Icons: Tabler or Lucide only.
- Check `frontend/src/_ui/` before creating a new UI component. Don't extend legacy `react-bootstrap`.
- Issues are tracked on the fork (`origin` = `HateTM/ToolJet`), not upstream, via `gh issue ...`. Use triage labels per `docs/agents/triage-labels.md`.
- Read `CONTEXT.md` and `docs/adr/` before exploring an area; proceed silently if absent.
- Before running `server/` or `frontend/` tests, check `engines` in `package.json` (Node 22.15.1). After changes, reread and run the smallest relevant test; state exactly what passed.
- Require approval before destructive actions (DB reset/drop, production deploy, force push).

## Codex-Only Subagent Rule

Codex only: when the user explicitly asks to launch or use subagents, run them with `gpt-5.6-luna` and `max` reasoning effort. Do not apply this rule outside Codex.

Example: “parallel reviewers” → LUNA/`max` in Codex; other harnesses use their own settings.