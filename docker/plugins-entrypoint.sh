#!/bin/bash
set -e

# The host's ./plugins is bind-mounted over /app/plugins, so everything the image
# produced there at build time is invisible at runtime — except node_modules,
# which docker-compose keeps container-native via the `plugins_node_modules`
# volume. That volume is what makes `tsc`, and the connectors' native modules,
# built against this image's glibc instead of the host's.
#
# Consequences we have to handle here, at container start:
#   1. A few packages get their own nested packages/*/node_modules. Those live
#      inside the bind mount, so they are missing on a fresh checkout and have to
#      be installed from in here (never on the host — wrong glibc).
#   2. plugins/client.js, plugins/server.ts, plugins/dist and packages/*/dist are
#      all gitignored build output living inside the bind mount. `tsc -b --watch`
#      cannot bootstrap them cold (packages/common has no dist yet, so every
#      other package fails to resolve @tooljet-plugins/common), so a full
#      `npm run build` has to run once before the watcher starts.

cd /app

PLUGINS_DIR=/app/plugins
INSTALL_STAMP="$PLUGINS_DIR/.docker-install-stamp"

lock_hash() {
  sha1sum "$PLUGINS_DIR/package-lock.json" | cut -d' ' -f1
}

# --- 1. dependencies -------------------------------------------------------
# The stamp lives in the bind mount, next to the nested packages/*/node_modules
# it vouches for, so it is absent exactly when those are absent.
if [ ! -x "$PLUGINS_DIR/node_modules/.bin/tsc" ] || [ "$(cat "$INSTALL_STAMP" 2>/dev/null)" != "$(lock_hash)" ]; then
  echo "[plugins] installing dependencies (first run, or package-lock.json changed)..."
  npm --prefix plugins install
  lock_hash > "$INSTALL_STAMP"
  echo "[plugins] dependencies installed"
else
  echo "[plugins] dependencies up to date"
fi

# --- 2. build output -------------------------------------------------------
if [ ! -f "$PLUGINS_DIR/dist/server.js" ] ||
   [ ! -f "$PLUGINS_DIR/client.js" ] ||
   [ ! -f "$PLUGINS_DIR/packages/common/dist/index.js" ]; then
  echo "[plugins] no build output found — running a full build (this takes a few minutes)..."
  npm run --prefix plugins build
  echo "[plugins] build complete"
else
  echo "[plugins] build output present — skipping full build"
fi

# `server` and `client` poll for these two files before booting.
echo "[plugins] ready — starting watcher"

exec "$@"
