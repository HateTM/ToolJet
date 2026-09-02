# Merge upstream before rebuilding the deployed container

The running `Tooljet-app` container (`tooljet/tooljet:ee-latest`) was built from upstream at 298 commits past the fork's branch point, none of which the fork has absorbed; the fork's `main` carries 89 commits of AI Builder work upstream never got. Rebuilding the container straight from the fork's current `main` would ship AI Builder but silently regress every upstream fix from those 298 commits.

Decided: `git merge upstream/develop` into the fork's `main` first (not rebase — 89 commits against 298 makes a single merge cheaper than per-commit rebase conflicts), then bring the feature branch up to date with that `main`, then build. Conflicts default to the fork's side, especially in the AI Builder module — the fork's own EE-independent implementation is the point of the exercise — with upstream accepted wherever there's no direct overlap. EE submodule gitlink conflicts resolve to the fork's current (empty) state; upstream's EE pointer changes are not needed here since the fork runs EE-independent by design.

The container is rebuilt with the existing `docker/ce-production.Dockerfile`, tagged `tooljet/tooljet:ee-latest` to match `~/docker-compose.yaml` (no compose changes needed), and tests run before it replaces the live container on port 80 (`restart: always`).
