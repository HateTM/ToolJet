# Generation engine — stateless Fastify service (ADR-0029). Plain Node+Docker
# for a TrueNAS custom app (ADR-0032), no edge/serverless assumptions, no port
# published to the host — reachable only from tooljet-ce:local on a shared
# internal docker network.

FROM node:22.15.1-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.15.1-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# Internal only — see ADR-0032, no -p publish in the TrueNAS app config.
EXPOSE 3100

CMD ["node", "dist/server.js"]
