#!/usr/bin/env bash
# Deploy ToolJet fork to TrueNAS (10.10.20.2) as custom compose app `tooljet`.
# Usage: bash scripts/deploy-nas-tooljet.sh [ref]   (default: main)
set -euo pipefail

REF="${1:-main}"
HOST="truenas_admin@10.10.20.2"
KEY="$HOME/.ssh/truenas_key"
SRC_DIR="/mnt/NaS/Apps/tooljet-src"
IMAGE="tooljet-ce:local"

cd "$(git rev-parse --show-toplevel)"

# Deploy only committed state; untracked artifacts (graphify-out/) are fine.
[ -z "$(git status --porcelain --untracked-files=no)" ] || {
  echo "Dirty tree — deploy only committed state" >&2
  exit 1
}
SHA=$(git rev-parse --short "$REF")
echo "Deploying $SHA ($REF)"

# 1. Ship source via git archive and unpack on NAS
git archive "$SHA" | ssh -i "$KEY" -o BatchMode=yes "$HOST" \
  "sudo rm -rf $SRC_DIR && sudo mkdir -p $SRC_DIR && sudo tar -x -C $SRC_DIR"

# 2. Build image on NAS
ssh -i "$KEY" -o BatchMode=yes "$HOST" \
  "sudo docker build -f docker/ce-production.Dockerfile -t $IMAGE $SRC_DIR"

# 3. Redeploy the app (fails with 'app not found' on first deploy — create it via MCP)
ssh -i "$KEY" -o BatchMode=yes "$HOST" "sudo midclt call app.redeploy tooljet" \
  || echo "NOTE: app 'tooljet' not created yet — install it, then rerun this script"

echo "Smoke test:"
ssh -i "$KEY" -o BatchMode=yes "$HOST" \
  "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/ || true"
