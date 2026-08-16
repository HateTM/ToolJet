---
status: accepted
---

# Step execution runs in-process over the same SSE connection as `approvePrd`, not a background job

`sendUserMessage` (ticket #3) already streams an LLM reply to the chat panel by holding the HTTP connection open and writing SSE events as they happen. Executing a Step list after approve needs the same shape of feedback — "step 2 of 5" progress, then success or failure — and no background-job infrastructure (BullMQ queue, polling, job-status endpoint) exists yet for AI Builder execution.

We could instead enqueue a BullMQ job for step execution and have the frontend poll or open a second connection for status. That would tolerate the user closing the tab mid-execution and scale better for long plans, but it's new infrastructure this ticket's scope doesn't ask for, and it breaks the established SSE-over-one-request pattern the chat panel is already built around.

Decided: `approvePrd` holds the request open and executes the Step list in order, in-process, writing `step-progress` / `step-done` / `step-failed` / `error` / `done` SSE events as it goes — the same `AiUtilService.sendSSE` helper `sendUserMessage` uses. Each Step's retry loop (up to 2 retries) happens synchronously within this same request. If the connection drops mid-execution, already-succeeded Artifacts remain applied (they're persisted per-step, not batched at the end); resuming a half-executed plan is out of scope for this ticket (Rewind, ticket #6, is the mechanism for revisiting execution state).

If a later ticket needs execution to survive a closed tab or run long plans, that's the point to introduce a real job queue — not before it's needed.
