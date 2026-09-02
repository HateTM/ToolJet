# Working a ticket

The loop one AI Builder ticket goes through in this fork, from picking it up to seeing its issue close. Written from the sequence that actually ships work here, including the parts that have bitten us — the checks whose defaults lie, and the merge strategy that turns a convenient branch into a conflict.

Companion docs: `CONTEXT.md` (the AI Builder's ubiquitous language), `docs/adr/` (decisions, immutable once accepted), `CLAUDE.md` (repo layout and coding conventions).

## Before you start

**Clear the context.** A ticket is a pipeline stage of its own. Start it from the issue, its ADRs and `CONTEXT.md` — not from the tail of the conversation that finished the last one. Carried-over context drifts: it remembers decisions from a different ticket and quietly applies them here.

**Branch from a freshly-fetched `origin/main`.**

```
git fetch origin
git checkout -b feature/<issue-id>-<short-name> origin/main
```

Never stack a new ticket on a branch whose PR already merged. PRs land here by **rebase** (and at least one landed by **squash**), so the commits on `main` always carry rewritten SHAs. A branch sitting on top of a merged branch has a merge-base that predates those rewrites, and git replays already-merged content: PR #35 hit 17 conflicting files this way, including an add/add on a file both sides had "added".

Prefixes: `feature/`, `fix/`, `docs/`, `chore/` — see `CLAUDE.md`.

**Read before writing.** The issue body, then the ADRs it names, then the matching `CONTEXT.md` glossary entry. Several AI Builder issues were filed before the feature existed and describe a pre-implementation world — check the branch's own history before believing an issue's framing. One was closed as `wontfix` on that mistake and had to be reopened.

**If the body says "Needs scoping", scope it first.** Settle the open question — as an ADR when it is a real decision — and only then write code. #26 is the worked example: it was split out of #19 purely to settle one collision, produced ADR-0018, and unblocked #14.

## Build it

**TDD at the seams.** Red test, then implementation, then green. The seams that have held up:

- `AgentsService.*` — the agent methods that touch the App and the DB.
- `AiService`'s step execution — reached through `approvePrd` with a mocked gateway.
- The frontend Zustand stores — `aiBuilderStore` in particular.

**Mutation-check every new guard.** Break the condition, confirm the failing test is exactly the one that claims to cover it, restore. A guard whose test passes both ways is decoration. This has caught tests that pinned nothing more than once.

**Run one spec file often, the suite at the end.**

## Check it

Server unit tests, under Node 22:

```
cd server
PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH" npx jest --config jest.ai-unit.config.js
```

Typecheck — read the delta, not the total:

```
PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH" npx tsc --noEmit -p tsconfig.json
```

The fork's baseline is **131 errors**, essentially all from the empty `@ee/*` submodules and test helpers. Check only whether your own files appear in the list.

Lint **only the files you touched**:

```
npx eslint src/modules/ai test/modules/ai/unit
```

Do not run `--fix` across the repo, or even across a whole module you happen to be in. `server/src/modules/data-sources/repository.ts` alone carries 191 pre-existing prettier violations; fixing them buries your change in noise.

For frontend tickets:

```
cd frontend
npm run lint
npm test -- <pattern>
```

**`npm run typecheck` is vacuous for `.js`/`.jsx`.** `frontend/tsconfig.json` includes only `src/**/*.ts` and `src/**/*.tsx`, with `checkJs: false`. Most AI Builder frontend code is `.jsx`, so a green typecheck there proves nothing about it. Do not report it as verification.

Three of `frontend`'s existing suites fail at load (a missing `FlexChildLayoutPanel`, a broken svg transformer under Jest 28). That is the standing baseline — suite loads, not tests. Compare against it rather than treating red as your regression.

## Review it

Run the two-axis review before committing:

```
/code-review <base>
```

**Standards** asks whether the change follows the repo's documented conventions and smells; **Spec** asks whether it implements what the issue actually asked for. They run separately on purpose — code can pass one and fail the other, and merging the reports lets one mask the other. Both axes have returned substantive findings: on #14, Standards caught a missing check on the *kind* of SQL statement being stored, and Spec caught a permission bypass in a data-source lookup.

Fix the findings, then re-run the checks above.

## Record it

**Write an ADR when a decision was made, not merely when code was written.** An ADR earns its place if a reader would otherwise ask "why this and not the obvious other thing" — it must state the rejected alternatives and why they lost. ADRs are immutable once accepted; a later decision that changes one gets its own ADR plus an amendment banner on the old.

**Update `CONTEXT.md`** when a term enters the vocabulary or an existing entry becomes false. It is a living glossary, unlike the ADRs.

## Ship it

Commit — imperative subject, body explaining the why, and the trailers:

```
Closes #<id>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Push, then open a PR against `main`.

**Put `Closes #<id>` in the PR body, not only in the commits.** A squash merge takes the PR title and body as the commit message; references living only in individual commits are lost.

Before merging, check the PR is actually mergeable. If it reports conflicts:

```
git cherry -v origin/main HEAD
```

`-` marks commits whose patch is already upstream, `+` the genuinely new ones. Drop the former:

```
git rebase --onto origin/main <last-already-upstream-sha> <branch>
```

On PR #35 this cut the diff from 58 files / 4946 additions to 45 / 2612 and resolved every conflict without touching a single file by hand.

After the merge: confirm the issues closed, `git fetch`, move the worktree back onto `origin/main`, and delete the local branch rather than reusing it.

## Ordering tickets

The order is driven by four kinds of dependency, in descending strength:

1. **Data-shape before its renderer.** Whatever defines a structure ships before whatever displays it, or the display is built twice. (#23 before #20.)
2. **Same function, smallest first.** Two tickets editing one function: the narrow fix goes first and the larger feature inherits it. (#34 before #24.)
3. **Vocabulary before the thing that dispatches on it.** Anything that walks over every artifact or step type ships after the tickets that add new ones. (#13, #23, #21 before #15.)
4. **Shared file, serialised.** Tickets touching one component are ordered rather than parallelised. (#19, #20, #21 all edit `AiBuilderChatPanel.jsx`.)

Beyond those, prefer small isolated fixes that improve every generated app over large features.

### Snapshot — 2026-08-28

The live list is the issue tracker; this records the ordering the rules above produced, so the reasoning survives even as the numbers change.

| Order | Issue | Why here |
|---|---|---|
| 1 | #34 | Form field types — one function, pure backend, improves every generated app |
| 2 | #19 | Data-source picker — the backend half landed with ADR-0019 |
| 3 | #23 | Foreign keys and indexes in `createTableTool` |
| 4 | #20 | Schema preview — renders what #23 produces |
| 5 | #24 | Form edit mode — inherits #34's type mapping |
| 6 | #13 | Widget allow-list |
| 7 | #21 | Plan phases and skip/continue |
| 8 | #15 | Automatic rollback — must know every artifact type and skipped steps |
| 9 | #18 | Richer prompt entry UX |
| 10 | #12 | Re-read after #18; likely subsumed by it |
| 11 | #27 | `@`-mentions — needs a CodeMirror composer, highest UI risk, no dependents |

## Known gap: the test harness

`cd server && npm test` cannot run in this fork at all, for two independent reasons:

1. The machine's default `node` is v24 but the repo requires 22.15.1; under Node 24, Jest reads `jest.config.ts` as native ESM and dies on its extensionless import.
2. Even under Node 22, `setupFilesAfterEnv` → `test/helpers/setup.ts` imports `@ee/audit-logs/module`, and `server/ee/` is an empty, uncloned submodule in this CE-only fork.

`server/jest.ai-unit.config.js` (checked in, also wired as `npm run test:ai`) keeps `rootDir`, the `moduleNameMapper` (including `scripts/`, `lib/`, the `mariadb` mock and `test-helper`, plus offline `@tooljet/plugins`, `isolated-vm` and `got` mocks) and the ts-jest transform, and drops `globalSetup`, `setupFiles`, `setupFilesAfterEnv`, `runner: 'groups'` and `coverageConfig`. It covers the AI unit specs plus the mocked tooljet-db create-table spec; the other `test/modules/*/unit` suites still fail on the missing `@ee/*` modules.

Fixing the harness properly is still unfiled.

## CLI quirks

`gh issue view` and `gh pr edit` both fail in this repository with a Projects-classic GraphQL deprecation error. Use the REST API instead:

```
gh api repos/HateTM/ToolJet/issues/<n>
gh api repos/HateTM/ToolJet/pulls/<n> -X PATCH -F body=@body.md
```

Issues live on the fork (`origin`), never upstream.
