# ADR-0029: Generation engine runs on Fastify as a stateless service

Date: 2026-09-01
Ticket: #83 (web framework/runtime for the Generation engine)
Status: Accepted

## Context

The Generation engine needs a web framework and runtime. Its API surface is narrow (1-2 SSE endpoints, ADR-0027), it holds no conversation/step state of its own (that stays in the ToolJet server's Postgres), it deploys as a plain Node+Docker container on TrueNAS (not edge/serverless), and any RAG processing is delegated to a separate external service (`~/UniStor`) rather than embedded.

## Decision

**Fastify.** Stateless service — no ORM, no session/auth layer, no RBAC (that all stays server-side); Fastify's SSE/streaming support and low overhead fit a narrow two-endpoint surface without bringing in machinery the engine doesn't use.

Rejected:
- **NestJS** — the fork's existing framework, but its DI/module/ORM conventions are built for a stateful, RBAC-aware app; the engine has neither, so adopting NestJS would mean carrying its structure without using what it's for.
- **Hono, Elysia, Encore.ts, Nitro, tRPC** — each targets edge/serverless deployment or a different API style (RPC-first, multi-runtime); none offers an advantage over Fastify for a stateless Node+Docker service on TrueNAS.

## Consequences

- The engine has no database dependency of its own; all persistence (conversation, Steps, Artifacts) stays owned by the ToolJet server, reached only through the SSE protocol (ADR-0027).
- `@ai-sdk/openai` and the LLM-calling patterns already used in `server/src/modules/ai/` carry over directly — same Node/TypeScript stack, no framework-driven rewrite of that layer.
- If the engine ever needs its own persistence, that reopens this decision rather than bolting state onto a service designed stateless.
