#!/bin/bash
set -e

# `server` requires @tooljet/plugins/dist/server and `client` imports
# @tooljet/plugins/client at bundle time. Both are gitignored build output
# produced by the `plugins` container into the shared ./plugins bind mount, so on
# a fresh checkout they do not exist yet when these services start. depends_on
# only waits for the plugins *container* to start, not for its first build to
# finish — so poll for the artifacts we actually need.

PLUGINS_DIR=${PLUGINS_DIR:-/app/plugins}
TIMEOUT=${PLUGINS_BUILD_TIMEOUT:-900}

waited=0
while [ ! -f "$PLUGINS_DIR/dist/server.js" ] || [ ! -f "$PLUGINS_DIR/client.js" ]; do
  if [ "$waited" -ge "$TIMEOUT" ]; then
    echo "Timed out after ${TIMEOUT}s waiting for the plugins build." >&2
    echo "Check the 'plugins' container logs: docker compose logs plugins" >&2
    exit 1
  fi
  if [ $((waited % 30)) -eq 0 ]; then
    echo "Waiting for the plugins build to produce dist/server.js and client.js (${waited}s)..."
  fi
  sleep 5
  waited=$((waited + 5))
done

echo "Plugins build is ready"

exec "$@"
