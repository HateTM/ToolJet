# ADR-0032: Generation engine deploys as its own TrueNAS app on a shared internal docker network

Date: 2026-09-01
Ticket: #88 (deployment/operation of the Generation engine process)
Status: Accepted

## Context

`tooljet-ce:local` already runs as a TrueNAS custom app alongside LocalAI (port 30286, host-published). The Generation engine needs a deployment story consistent with that setup, and the ToolJet server needs a way to reach it at runtime.

## Decision

Deploy the Generation engine as a **separate TrueNAS custom app**, sharing an explicit `external: true` docker network with `tooljet-ce:local` — the same pattern used by other multi-app TrueNAS SCALE setups on this host (Plex/Tautulli). Discovery is by internal service hostname on that network; unlike LocalAI, **no port is published to the host** — the engine is reachable only from `tooljet-ce:local`.

`tooljet-ce:local` gets a new environment variable, `GENERATION_ENGINE_URL`, analogous to the LLM config move in ADR-0031, pointing at the engine's internal hostname.

No explicit CPU/memory limits are set, following the precedent of the live EE container (`Memory=0`, `NanoCpus=0` observed on the running `Tooljet-app` container) and the engine's thin, stateless nature (ADR-0029). Revisit only if real resource contention shows up.

## Consequences

- The engine is not reachable from outside the shared docker network — no external attack surface beyond what `tooljet-ce:local` itself already exposes.
- Adding `GENERATION_ENGINE_URL` is the only server-side deployment change; no other TrueNAS app config changes.
- Unbounded resource limits are a deliberate bet on the engine staying thin; if it grows heavier (e.g. local embedding/inference), this ADR's limits stance should be revisited alongside that change, not silently inherited.
