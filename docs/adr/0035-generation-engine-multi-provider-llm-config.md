# ADR-0035: Generation engine owns LLM provider config, including the existing multi-provider/BYOK layer

Date: 2026-09-01
Ticket: #85 (LLM provider configuration model for the Generation engine); supersedes ADR-0031
Status: Accepted

## Context

ADR-0031 decided the Generation engine's LLM config should stay a plain 3-variable env model (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL`), rejecting multi-provider/BYOK as out of scope. That was written without checking prior tickets against the current fork state first: #59 ("multi-provider BYOK (бэкенд) — org-ключ, фабрика провайдеров, key-settings/update-key") had already shipped and closed on 2026-08-30, adding a provider factory (`LlmProvider` union: `anthropic`/`gemini`/`grok`/`openai`/`openrouter`/`tooljet_managed`, `server/src/modules/ai/constants/llm.ts`) and org-key storage. #65 (admin UI for provider/key management) was open, blocked only by #59, and depends on that abstraction existing.

A same-day ticket audit (2026-09-01) surfaced the conflict: ADR-0031, as written, would make #59's shipped work dead weight and #65 pointless. The map's own "Out of scope" note in issue #79 was written from the fork's pre-#59 baseline, not from an audit of what had already landed — it stated an intent, not a verified constraint.

## Decision

**Multi-provider/BYOK is in scope for the Generation engine.** The engine owns LLM provider configuration going forward, and that ownership includes the provider abstraction #59 already built — not just the single-provider `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`AI_MODEL` triple. Concretely:

- The `LlmProvider` factory and org-key storage move into the Generation engine's environment/config surface alongside the base 3 variables, the same way ADR-0031 already planned for the base triple to move (ADR-0032's `GENERATION_ENGINE_URL` wiring is unaffected).
- #65 (admin UI for provider/key management) remains a valid, in-scope ticket — it is not superseded by this map, and does not need to wait on Generation engine implementation to proceed, since the provider abstraction it configures already lives in the current fork and will simply move with the engine later.
- Issue #79's "Out of scope" line on multi-provider/BYOK is corrected by this ADR: it no longer applies. The line stays in the issue for history but should be read as reversed by ADR-0035.

Rejected: reverting #59's provider factory to force the fork back into a single-provider shape purely for consistency with an ADR written before this conflict was noticed. Discarding shipped, wanted functionality to make a decision retroactively true is worse than fixing the decision.

## Consequences

- ADR-0031 is marked Superseded rather than deleted, per this repo's convention (see ADR-0009, ADR-0020, ADR-0033) — its reasoning stays visible, but ADR-0035 is authoritative on this topic going forward.
- The Generation engine's config surface is now larger than a 3-variable env block: it needs to carry (or proxy to) whatever `key-settings`/`update-key` persistence #59 introduced, not just process-env values. The concrete mechanism (engine reads from the server, or the server passes resolved credentials per-request) is left to implementation, not fixed here.
- Future map/ADR work should check ticket state (open/closed, and *when* closed relative to the ADR) before declaring something out of scope, not just rely on the map's own prior notes — this incident is the concrete reason.
- #66/#67's ADR-0033 (catalogs rebuilt from scratch) is unaffected — that conflict was about component/event catalogs, not LLM provider config, and no shipped ticket contradicts it the way #59 contradicted ADR-0031.
