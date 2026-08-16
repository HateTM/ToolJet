---
status: accepted
---

# Vercel AI SDK (`@ai-sdk/openai`) for `AIGateway`, not a raw OpenAI client

`AIGateway(provider, operation_id, prompt_body, organizationId)` in `util.service.ts` is the sole point where the assistant talks to the LLM, and every Step-producing tool (`CreateComponent`, `CreateTable`, `CreateQuery`) needs the model to choose a tool and emit structured arguments, not just free text. A raw `fetch`/official `openai` client would work against LocalAI's OpenAI-compatible API, but tool-calling and streaming would have to be hand-rolled and manually parsed.

Decided: use `@ai-sdk/openai` (already an unused dependency in `server/package.json` — this looks like the originally intended choice) via `createOpenAI({ baseURL: process.env.OPENAI_BASE_URL, apiKey: process.env.OPENAI_API_KEY })`, and drive generation with `streamText()` + `tool()` definitions for `CreateComponent`/`CreateTable`/`CreateQuery`. Tool selection is delegated to the SDK/model rather than a separate `classify` routing step. Model name is configured via a new `AI_MODEL` env var, since LocalAI serves specific loaded models by name.
