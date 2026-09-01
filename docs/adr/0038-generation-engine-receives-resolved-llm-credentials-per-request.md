# ADR-0038: Generation engine receives resolved LLM credentials per request; it does not read org-key storage itself

Date: 2026-09-01
Ticket: #94 (Generation engine: LLM provider config, including multi-provider/BYOK)
Status: Accepted

## Context

ADR-0035 (superseding ADR-0031) put multi-provider/BYOK config ownership in scope for the Generation engine, but left one mechanism explicitly open: "the engine reads org-key storage directly, or the server proxies resolved credentials per-request."

ADR-0035 and ADR-0031 are not yet merged to `main` — they exist on the `#79` docs branch (commits `a9de31fba`, `e27495232`), unmerged as of this ticket. This ADR treats their content as decided (per the parent ticket's instructions) and cites them accordingly; a reader on `main` before that branch lands will not find them yet.

Separately, ADR-0029 (accepted, part of the merged #90 scaffold) already fixed the engine's shape: **stateless, no ORM, no session/auth layer, no RBAC** — all persistence, including `organization_ai_keys`, stays owned by the ToolJet server. The engine's only channel to the server is the SSE protocol (ADR-0027).

## Decision

**The server resolves credentials and passes them to the engine per request.** The engine never queries `organization_ai_keys`, never holds `EncryptionService`, and never scopes anything by `organizationId` on its own — reading org-key storage directly would require giving a service ADR-0029 specified as stateless a TypeORM connection, the encryption key material, and org-scoping logic it has no other reason to carry.

Concretely, the engine exposes a pure resolution seam that takes an already-decrypted config envelope:

```ts
interface EffectiveLlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseURL?: string;
}
```

and returns an AI SDK language model (`resolveLanguageModel`), plus a separate `resolveFromEnv()` for the base 3-variable fallback (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL`) when no org config exists — mirroring `buildProvider`/`resolveModel` in `server/src/modules/ai/util.service.ts` today. The server-side call that assembles `EffectiveLlmConfig` from `AiKeySettingsService.getEffectiveOrgConfig` and hands it to the engine over the wire is out of scope for this ticket — it depends on #91 (SSE proxy), which has not landed.

Rejected: engine reads `organization_ai_keys` directly. Discarded because it contradicts ADR-0029 outright (adds DB/ORM/encryption dependencies to a service specified to have none) and duplicates org-scoping/permission logic (`AiKeySettingsService.assertAdmin`) that already lives server-side.

## Consequences

- Decrypted API keys cross the server→engine network hop on every request. This is acceptable without engine-side auth because ADR-0032 already isolates that hop: the engine publishes no host port and is reachable only from `tooljet-ce:local` on the shared internal docker network.
- The engine's provider factory (`generation-engine/src/config/provider.ts`) is a pure function of `EffectiveLlmConfig` — trivially unit-testable per `LlmProvider` value without mocking the DB, satisfying this ticket's "unit tests on provider resolution for each `LlmProvider`" acceptance criterion.
- `server/src/modules/ai/util.service.ts`'s `resolveModel`/`buildProvider` are **not removed** by this ticket: #91 (the SSE proxy that would actually route requests through the engine) has not landed, so the server's own AI Builder flow still depends on them. Acceptance criterion "server no longer needs `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL`" and "org-key/provider switching keeps working end-to-end through the engine" are not verifiable until #91 ships — flagged as a known gap in this ticket's PR, not silently claimed done.
- #65 (admin UI for provider/key management) is unaffected: it continues to target the server's existing `key-settings`/`update-key` endpoints, which are untouched here.
