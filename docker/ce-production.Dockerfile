FROM node:24.18.1 AS builder

# Fix for JS heap limit allocation issue
ENV NODE_OPTIONS="--max-old-space-size=8096"

RUN npm i -g npm@11.16.0
RUN mkdir -p /app

WORKDIR /app

# Scripts for building
COPY ./package.json ./package.json

# Build plugins
COPY ./plugins/package.json ./plugins/package-lock.json ./plugins/
RUN npm --prefix plugins install
COPY ./plugins/ ./plugins/
RUN NODE_ENV=production npm --prefix plugins run build
# `npm prune` walks the existing tree deleting devDependencies in place and hangs
# indefinitely under npm 11.16.0 on this workspace (reproduced repeatedly — no
# CPU, no network, no child process, stuck in its own epoll_wait). A clean
# reinstall from the lockfile sidesteps it entirely — same end state (prod-only
# node_modules), same pattern generation-engine/Dockerfile already uses.
RUN rm -rf plugins/node_modules && npm --prefix plugins ci --omit=dev

# Build frontend
COPY ./frontend/package.json ./frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci --legacy-peer-deps
COPY ./frontend/ ./frontend/
RUN npm --prefix frontend run build --production
# No prune here: frontend/node_modules is never copied into the final image
# below (only the static frontend/build output is) — pruning it was dead work.

ENV NODE_ENV=production

# Build server
COPY ./server/package.json ./server/package-lock.json ./server/
RUN npm --prefix server install
COPY ./server/ ./server/
RUN npm install -g @nestjs/cli
RUN npm install -g copyfiles
RUN npm --prefix server run build

FROM debian:12

RUN apt-get update -yq \
    && apt-get install curl gnupg zip -yq \
    && apt-get install -yq build-essential \
    && apt-get clean -y


RUN curl -O https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.xz \
    && tar -xf node-v24.18.1-linux-x64.tar.xz \
    && mv node-v24.18.1-linux-x64 /usr/local/lib/nodejs \
    && echo 'export PATH="/usr/local/lib/nodejs/bin:$PATH"' >> /etc/profile.d/nodejs.sh \
    && /bin/bash -c "source /etc/profile.d/nodejs.sh" \
    && rm node-v24.18.1-linux-x64.tar.xz
ENV PATH=/usr/local/lib/nodejs/bin:$PATH

ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=4096"
RUN apt-get update && \
    apt-get install -y postgresql-client freetds-dev libaio1 libxml2 wget redis-server supervisor && \
    apt-get -o Dpkg::Options::="--force-confold" upgrade -q -y --force-yes && \
    apt-get -y autoremove && \
    apt-get -y autoclean

# Install Instantclient Basic Light Oracle and Dependencies
WORKDIR /opt/oracle

RUN wget https://tooljet-plugins-production.s3.us-east-2.amazonaws.com/marketplace-assets/oracledb/instantclients/instantclient-basiclite-linuxx64.zip && \
    wget https://tooljet-plugins-production.s3.us-east-2.amazonaws.com/marketplace-assets/oracledb/instantclients/instantclient-basiclite-linux.x64-11.2.0.4.0.zip && \
    unzip instantclient-basiclite-linuxx64.zip && rm -f instantclient-basiclite-linuxx64.zip && \
    unzip instantclient-basiclite-linux.x64-11.2.0.4.0.zip && rm -f instantclient-basiclite-linux.x64-11.2.0.4.0.zip && \
    cd /opt/oracle/instantclient_21_10 && rm -f *jdbc* *occi* *mysql* *mql1* *ipc1* *jar uidrvci genezi adrci && \
    cd /opt/oracle/instantclient_11_2 && rm -f *jdbc* *occi* *mysql* *mql1* *ipc1* *jar uidrvci genezi adrci && \
    echo /opt/oracle/instantclient* > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig
# Set the Instant Client library paths
ENV LD_LIBRARY_PATH="/opt/oracle/instantclient_11_2:/opt/oracle/instantclient_21_10:${LD_LIBRARY_PATH}"


WORKDIR /

# appuser must exist before any COPY --chown below resolves it, and before the
# redis dirs are created.
RUN useradd --create-home --home-dir /home/appuser appuser \
    && mkdir -p /app /var/lib/redis /var/log/redis \
    && chown appuser:0 /app \
    && chmod u+x /app \
    && chown -R appuser:0 /home/appuser /var/lib/redis /var/log/redis \
    && chmod -R g=u /var/lib/redis /var/log/redis

# Every COPY below sets ownership directly (--chown=appuser:0) instead of a
# separate `chown -R /app` pass. On this host's storage (ZFS-backed overlay2),
# a recursive chown after the fact forces a per-file "copy-up" out of the
# read-only image layer, each one committing its own ZFS transaction group —
# reproduced hanging for 50+ minutes on node_modules with only ~13 files
# processed (confirmed via /proc/<pid>/stack: stuck in zfs_link ->
# txg_wait_synced, called from ovl_copy_up_one). COPY --chown writes files
# with the right owner as they're created, so no copy-up pass is needed at all.
# copy npm scripts
COPY --from=builder --chown=appuser:0 /app/package.json ./app/package.json
# copy plugins dependencies
COPY --from=builder --chown=appuser:0 /app/plugins/dist ./app/plugins/dist
COPY --from=builder --chown=appuser:0 /app/plugins/client.js ./app/plugins/client.js
COPY --from=builder --chown=appuser:0 /app/plugins/node_modules ./app/plugins/node_modules
COPY --from=builder --chown=appuser:0 /app/plugins/packages/common ./app/plugins/packages/common
COPY --from=builder --chown=appuser:0 /app/plugins/package.json ./app/plugins/package.json
# copy frontend build
COPY --from=builder --chown=appuser:0 /app/frontend/build ./app/frontend/build
# copy server build
COPY --from=builder --chown=appuser:0 /app/server/package.json ./app/server/package.json
COPY --from=builder --chown=appuser:0 /app/server/.version ./app/server/.version
COPY --from=builder --chown=appuser:0 /app/server/node_modules ./app/server/node_modules
COPY --from=builder --chown=appuser:0 /app/server/templates ./app/server/templates
COPY --from=builder --chown=appuser:0 /app/server/scripts ./app/server/scripts
COPY --from=builder --chown=appuser:0 /app/server/dist ./app/server/dist

COPY --chown=appuser:0 ./docker/ce-entrypoint.sh ./app/server/entrypoint.sh
# Configure Redis — bind to localhost only, daemonized, no persistence needed for CE single-instance
# Written to /app (appuser-owned) to avoid /etc/redis permission issues
RUN printf 'bind 127.0.0.1\nport 6379\nprotected-mode yes\ndaemonize yes\nlogfile /var/log/redis/redis.log\ndir /var/lib/redis\n' \
    > /app/redis.conf

# Set npm cache directory
ENV npm_config_cache /home/appuser/.npm

ENV HOME=/home/appuser
USER appuser

WORKDIR /app
# Dependencies for scripts outside nestjs
RUN npm install dotenv@10.0.0 joi@17.4.1

# ce-entrypoint.sh runs db:setup then `exec "$@"` — with no CMD, "$@" is empty,
# `exec` with nothing is a no-op, and the entrypoint script (the container's
# PID 1) just runs off the end and exits 0. `restart: always` then relaunches
# the whole container from scratch, re-running db:setup every time — no crash,
# no error, just an infinite "successful" restart loop that never actually
# serves traffic. Confirmed via `docker inspect`: ExitCode=0, RestartCount
# climbing. Same missing-CMD pattern in server.Dockerfile.
#
# Must be `npm run start:prod` (root package.json's `--prefix server` proxy),
# not a direct `node .../dist/src/main` call from WORKDIR /app: the app's own
# dynamic module loader (getImportPath, app/constants/index.ts) resolves
# EE/CE module paths off `process.cwd()` expecting it to already be
# `/app/server` (matching how db:setup above also runs via the same
# `--prefix server` proxy) — a direct `node` invocation leaves cwd at `/app`
# and the loader looks for `/app/dist/src/modules/...` instead of
# `/app/server/dist/src/modules/...`, throwing MODULE_NOT_FOUND on
# audit-logs/ability at boot every time.
ENTRYPOINT ["./server/entrypoint.sh"]
CMD ["npm", "run", "start:prod"]
