# ADR-0035: Server-side proxy to the Generation engine is flag-guarded, not a hard switch

Date: 2026-09-01
Ticket: #91 (Generation engine: SSE endpoint + server-side proxy)
Status: Accepted

## Context

Issue #91 asks the server's PRD-streaming call sites to replace their in-process generation
with an HTTP/SSE call to the Generation engine. But nothing deploys the engine yet: it is not
wired into the root `build` orchestration chain (CONTEXT.md), ADR-0032's TrueNAS app/network
doesn't exist, and this repo's own `grep` for `GENERATION_ENGINE_URL` before this ticket
returned nothing. A literal "replace the call" would mean every PRD generation — in every dev
checkout and the running production container — starts failing the moment this PR merges,
until the engine is separately deployed.

## Decision

`AiService.sendUserMessage` checks `GenerationEngineClient.isConfigured()`
(`GENERATION_ENGINE_URL` set) before proxying. If unset, it falls back to the pre-#91
in-process `AiUtilService.AIGateway` call, unchanged. The engine-configured path is new,
tested, and ready; it only activates once ADR-0032's deployment actually exists and the env
var is set.

Rejected: a hard switch with no fallback, matching the issue text literally. Rejected because
it fails every generation for every deployment that hasn't stood up the engine yet — including
this fork's own dev and production environments today — trading a real, working feature for
a broken one on the promise of a not-yet-deployed replacement.

## Consequences

- Once the engine is deployed (ADR-0032) and `GENERATION_ENGINE_URL` is set in
  `tooljet-ce:local`'s environment, the proxy path activates with no further server code
  change — flipping the env var is the whole cutover.
- The in-process `AIGateway` fallback in `AiService` is not deleted by this ticket; removing
  it (once the engine is the only supported path) is a follow-up decision, not implied here.
- `sendUserDocsMessage` (the Learn/docs chat path) is untouched — it was never in scope for
  #91 (PRD generation only, per the issue body) and keeps calling `AIGateway` unconditionally.
