#!/bin/bash
# Reachability smoke test for the Generation engine's TrueNAS deployment
# (ADR-0032, ticket #96). Run from inside the tooljet-ce:local container (or
# any container on the shared `tooljet-shared` network) — not from the host,
# since no port is published there by design.
#
#   docker exec Tooljet-app deploy/truenas/smoke-test-generation-engine.sh
#
# This only proves network/DNS reachability against the engine's /health
# endpoint (ticket #90's scaffold). It does NOT exercise a real generation
# request round-trip — that half of #96's acceptance criteria is blocked on
# #95 (the pipeline) landing a route to call. TODO(#95): extend this script,
# or add a companion one, once the engine has a generation endpoint to hit.
set -euo pipefail

URL="${GENERATION_ENGINE_URL:?GENERATION_ENGINE_URL is not set}"

echo "Checking ${URL}/health ..."
response="$(curl -fsS --max-time 5 "${URL}/health")"

if [[ "$response" != *'"status":"ok"'* ]]; then
  echo "Unexpected response from ${URL}/health: ${response}" >&2
  exit 1
fi

echo "OK: ${response}"
