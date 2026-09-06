FROM node:24.18.1 AS builder

# Все инструменты сборки в одном слое: node-gyp + nsjail + Python sandbox
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 make g++ \
    autoconf bison flex libprotobuf-dev libnl-route-3-dev libtool pkg-config protobuf-compiler \
    python3.11 python3.11-venv python3-pip \
    curl ca-certificates tar xz-utils \
    && rm -rf /var/lib/apt/lists/*

# nsjail (Python sandbox)
WORKDIR /build-nsjail
RUN git clone --depth 1 --branch 3.4 https://github.com/google/nsjail.git && \
    cd nsjail && make && strip nsjail

# Python runtime для sandbox
RUN python3.11 -m venv /opt/python-runtime && \
    /opt/python-runtime/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
    /opt/python-runtime/bin/pip install --no-cache-dir \
    numpy==1.26.4 pandas==2.2.1 requests==2.31.0 httpx==0.27.0 \
    python-dateutil==2.9.0 pytz==2024.1 pydantic==2.6.4 typing-extensions==4.10.0

# Node/npm (выровнено с CE: Node 24, npm 11)
ENV NODE_OPTIONS="--max-old-space-size=8096"
COPY ./.npmrc ./.npmrc
RUN npm i -g npm@12.0.2
# npm 12 blocks remote-tarball deps by default; locks pin xlsx via the sheetjs
# CDN. `npm config set` does not survive `--prefix`, so every install below
# carries the flag explicitly.
RUN mkdir -p /app
WORKDIR /app

COPY ./package.json ./package.json


# Plugins — npm install для сборки, npm ci --omit=dev для продакшена
# (вместо npm prune --production, который зависает на npm 11)
COPY ./plugins/package.json ./plugins/package-lock.json ./plugins/
RUN npm --prefix plugins install --allow-remote=all 
COPY ./plugins/ ./plugins/
RUN NODE_ENV=production npm --prefix plugins run build
RUN rm -rf plugins/node_modules && npm --prefix plugins ci --omit=dev --allow-remote=all

# Frontend — npm ci вместо npm install

# Копируем манифесты зависимостей
COPY ./frontend/package.json ./frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci --legacy-peer-deps --allow-remote=all 

COPY ./frontend/ ./frontend/
RUN npm --prefix frontend run build --production
# Prune убран: frontend/node_modules не копируется в final (только build/)

# Server — npm ci + rm+ci pattern вместо prune
ENV NODE_ENV=production
ENV TOOLJET_EDITION=ce
COPY ./server/package.json ./server/package-lock.json ./server/
RUN npm --prefix server ci --legacy-peer-deps --include=dev && \
    npm --prefix server install --no-save --include=dev --legacy-peer-deps --allow-remote=all dotenv@10.0.0 joi@17.4.1
COPY ./server/ ./server/
RUN npm install -g @nestjs/cli copyfiles
RUN npm --prefix server run build


# PostgREST
ENV POSTGREST_VERSION=v12.2.0
RUN curl -Lo postgrest.tar.xz \
    https://github.com/PostgREST/postgrest/releases/download/${POSTGREST_VERSION}/postgrest-v12.2.0-linux-static-x64.tar.xz && \
    tar -xf postgrest.tar.xz && mv postgrest /postgrest && rm postgrest.tar.xz && chmod +x /postgrest

# ─────────────────────────────────────────────
# Final stage
# ─────────────────────────────────────────────

FROM debian:12

# Минимальный набор: без Oracle, freetds, libaio, libxml2
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget ca-certificates xz-utils tar zip unzip \
    postgresql-client redis \
    python3.11 python3.11-venv \
    libprotobuf32 libnl-route-3-200 \
    procps libcap2-bin \
    git openssh-client \
      && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Node.js 24.18.1 (выровнено с CE)
RUN curl -O https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.xz \
    && tar -xf node-v24.18.1-linux-x64.tar.xz \
    && mv node-v24.18.1-linux-x64 /usr/local/lib/nodejs \
    && rm node-v24.18.1-linux-x64.tar.xz
ENV PATH=/usr/local/lib/nodejs/bin:/opt/python-runtime/bin:$PATH
ENV NODE_ENV=production
ENV TOOLJET_EDITION=ce
ENV NODE_OPTIONS="--max-old-space-size=4096"

WORKDIR /

RUN useradd --create-home --home-dir /home/appuser appuser

# nsjail (setuid для sandbox)
COPY --from=builder /build-nsjail/nsjail/nsjail /usr/local/bin/nsjail
RUN chmod 4755 /usr/local/bin/nsjail

# Python runtime из builder
COPY --from=builder /opt/python-runtime /opt/python-runtime

# nsjail config
RUN mkdir -p /etc/nsjail
COPY docker/nsjail/python-execution.cfg /etc/nsjail/python-execution.cfg

# Python execution dirs
RUN mkdir -p /tmp/python-execution /tmp/python-bundles && \
    chmod 1777 /tmp/python-execution /tmp/python-bundles

# PostgREST с logging wrapper
COPY --from=builder --chown=appuser:0 /postgrest /usr/local/bin/postgrest
RUN mv /usr/local/bin/postgrest /usr/local/bin/postgrest-original && \
    printf '#!/bin/bash\nexec /usr/local/bin/postgrest-original "$@" 2>&1 | sed "s/^/[PostgREST] /"\n' > /usr/local/bin/postgrest && \
    chmod +x /usr/local/bin/postgrest

# App files — COPY --chown для ZFS (см. комментарии в CE Dockerfile)

COPY --from=builder --chown=appuser:0 /app/package.json ./app/package.json
COPY --from=builder --chown=appuser:0 /app/plugins/dist ./app/plugins/dist
COPY --from=builder --chown=appuser:0 /app/plugins/client.js ./app/plugins/client.js
COPY --from=builder --chown=appuser:0 /app/plugins/node_modules ./app/plugins/node_modules
COPY --from=builder --chown=appuser:0 /app/plugins/packages/common ./app/plugins/packages/common
COPY --from=builder --chown=appuser:0 /app/plugins/package.json ./app/plugins/package.json
COPY --from=builder --chown=appuser:0 /app/frontend/build ./app/frontend/build
COPY --from=builder --chown=appuser:0 /app/server/package.json ./app/server/package.json
COPY --from=builder --chown=appuser:0 /app/server/.version ./app/server/.version
COPY --from=builder --chown=appuser:0 /app/server/node_modules ./app/server/node_modules
COPY --from=builder --chown=appuser:0 /app/server/templates ./app/server/templates
COPY --from=builder --chown=appuser:0 /app/server/scripts ./app/server/scripts
COPY --from=builder --chown=appuser:0 /app/server/dist ./app/server/dist
COPY --chown=appuser:0 ./docker/LTS/ee/ee-entrypoint.sh ./app/server/ee-entrypoint.sh

# Frontend group write (OpenShift arbitrary UID)
RUN chmod -R g+w /app/frontend/build

# gitsync
RUN mkdir -p /app/server/tooljet/gitsync && \
    chown -R appuser:0 /app/server/tooljet && \
    chmod -R 2770 /app/server/tooljet/gitsync

# rsyslog (audit logs)
RUN mkdir -p /home/appuser/rsyslog && \
    chown -R appuser:0 /home/appuser/rsyslog && \
    chmod g+s /home/appuser/rsyslog && \
    chmod -R g=u /home/appuser/rsyslog

# npm cache
RUN mkdir -p /tmp/.npm/npm-cache/ /tmp/.npm/npm-cache/_logs && \
    chown -R appuser:0 /tmp/.npm/npm-cache/ /tmp/.npm/npm-cache/_logs && \
    chmod g+s /tmp/.npm/npm-cache/ /tmp/.npm/npm-cache/_logs && \
    chmod -R g=u /tmp/.npm/npm-cache/ /tmp/.npm/npm-cache/_logs
ENV npm_config_cache=/tmp/.npm/npm-cache/

# Redis
RUN mkdir -p /var/lib/redis /var/log/redis /etc/redis && \
    chown -R appuser:0 /var/lib/redis /var/log/redis /etc/redis && \
    chmod g+s /var/lib/redis /var/log/redis /etc/redis && \
    chmod -R g=u /var/lib/redis /var/log/redis /etc/redis
RUN printf 'bind 127.0.0.1\nport 6379\nprotected-mode yes\ndaemonize yes\nlogfile /var/log/redis/redis.log\ndir /var/lib/redis\n' \
    > /app/redis.conf
ENV npm_config_cache=/home/appuser/.npm
ENV HOME=/home/appuser
USER appuser
WORKDIR /app

ENTRYPOINT ["./server/ee-entrypoint.sh"]
CMD ["npm", "run", "start:prod"]
