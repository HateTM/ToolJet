# ADR-0027: Generation engine talks SSE, mirrored into the existing browser SSE

Date: 2026-09-01
Ticket: #81 (transport protocol between ToolJet server and Generation engine)
Status: Accepted

## Context

Extracting AI generation out of `server/src/modules/ai/` into a standalone **Generation engine** service (see `CONTEXT.md`, "In progress: `Generation engine` extraction") requires a wire protocol between the ToolJet server and the new service. The server already streams PRD generation token-by-token to the browser over SSE (`initSSE`/`sendSSE`, ADR-0005). Whatever transport is chosen for server↔engine has to preserve that UX without the server blocking on a full response before it can start streaming to the browser.

## Decision

**SSE**, mirroring the existing server↔browser pattern. The Generation engine exposes a narrow SSE surface; the ToolJet server proxies its stream directly into the outgoing SSE connection it already holds open to the browser — no buffering, no protocol translation layer.

Rejected: WebSocket/Socket.IO. Both give bidirectional, multi-message-type channels; the server↔engine link only needs one-directional token streaming with no mid-stream messages from the server back to the engine, so the extra connection machinery (handshake, reconnect/backoff, message framing) buys nothing here.

## Consequences

- The engine's SSE stream and the server's browser-facing SSE stream have the same shape, so the proxy is close to pass-through — no format translation to write or maintain.
- If server↔engine ever needs bidirectional signals (e.g. cancel mid-generation), SSE cannot carry them; that would need a separate side channel, not a transport switch, since the current pipeline (ADR-0028) never needs it.
