# ADR-0044: Interrupt model — a run pauses via `conversation.metadata.interrupt`, resumed by a side-channel endpoint

Date: 2026-09-02
Ticket: plan increment 6 (Interrupt model)
Status: Accepted (transport + `select_datasource`; `clarify_prd` deferred — see Scope)

## Context

`docs/plans/2026-09-02-ai-builder-expansion.md` increment 6 asks for a general way for a running plan to pause mid-execution and ask the user a question over SSE, then resume with the answer, with two V1 interrupt types: `select_datasource` and `clarify_prd`. Nothing like this existed before ADR-0042's confirmation gate (ticket #77): `executeCreateTableStep`'s `awaitExternalTableConfirmation` already pauses `approvePrd`'s single long-lived SSE request, waiting on a status flip written by a separate `confirm-step`/`skip-step` endpoint, via a bounded poll loop over the Step row (not an in-memory promise — the release write always arrives on a different HTTP request).

This ADR generalizes that proven mechanism into an `Interrupt`, rather than inventing a second, parallel pause protocol.

## Decision — mechanism

An `Interrupt` is a pause point inside a step-execution or PRD flow that needs an answer only a human can give. It reuses ADR-0042's shape exactly:

1. `raiseInterrupt(context, type, payload)` writes `conversation.metadata.interrupt = { id, type, payload, createdAt }` (read-merge-write, the same pattern `util.service.ts`'s `reactivateConversation` already uses for `metadata.handoff`), sends an `interrupt` SSE event carrying the same envelope, then polls `conversation.metadata` on an interval (`INTERRUPT_POLL_INTERVAL_MS`) up to a deadline (`INTERRUPT_TIMEOUT_MS`, 30 minutes — same value ADR-0042 uses, for the same reason: a human's response time, not a machine's).
2. `POST /ai/conversation/:id/interrupt-answer` (`{ interruptId, answer }`) is the side channel: it loads the conversation, checks `metadata.interrupt?.id === interruptId` (409 on a stale or repeated answer — the same shape `confirmStep` uses to reject a step that isn't `awaiting_confirmation`), then read-merge-writes `metadata.interrupt = { ...current, answer, answeredAt }`. It does not touch SSE — the paused request's poll picks the answer up on its next tick, exactly like `confirm-step` today.
3. On the poll finding an `answer`, `raiseInterrupt` clears `metadata.interrupt` (back to `undefined`) and resolves with the answer. On timeout, it throws — the same fail-the-run behavior a `CreateTable` confirmation timeout has today; there is no partial/default-and-continue path in V1.

**Storage is `conversation.metadata`, not a Step column**, even though ADR-0042's precedent is Step-scoped. Two reasons: an interrupt carries an open-shaped payload and an eventual answer, which a status enum can't hold, and a new jsonb column would need a migration the metadata column already avoids (`AddMetadataColumnInConversationTable`, no migration needed here). This is safe specifically because `ai_active_runs` already enforces one live run per conversation (`beginActiveRun`/`AiActiveRunService`) — so there is at most one live interrupt per conversation at any time, and no keying problem from sharing one `metadata.interrupt` slot across step-scoped and (future) pre-plan interrupts.

**Relationship to ADR-0042's confirmation gate:** deliberately not refactored in this pass — `awaitExternalTableConfirmation` keeps polling the Step row, `raiseInterrupt` polls conversation metadata. They are the same protocol shape (checkpoint + bounded poll + side-channel write), not the same code path. A future pass could fold External-write-confirmation into an `Interrupt` type once there's a second caller to justify the merge; doing it as part of this ADR would mean touching Step-status semantics that ticket #77 already shipped and tested.

**Ownership/authorization** on `interrupt-answer` mirrors `confirmStep`: `loadConversationOfType(conversationId, "generate", userId)` — a caller who doesn't own the conversation gets the same 404/403 shape every other conversation-scoped endpoint gives, not a new authorization path.

## Decision — scope: `select_datasource` only, `clarify_prd` deferred

The plan names two V1 interrupt types. They are not equally cheap:

- **`select_datasource`** has a real, already-existing ambiguity point: `resolveExternalDataSource` (used by both the SQL and REST API `CreateQuery` branches) throws today whenever `data_source_id` is missing or doesn't match a connected source. When it's missing specifically *and there is more than one connected data source* (`context.dataSources.length > 1`), that isn't a model mistake to retry — it's a genuine question only the user can answer, since the prompt's connected-sources block cannot force the model to always guess right. This ADR changes exactly that branch: instead of throwing, it raises a `select_datasource` interrupt with the candidate list as payload and uses the answered id. An invalid (non-matching) id is left as a retryable model error, unchanged — that's a hallucination, not ambiguity.
- **`clarify_prd`** would need the *model* to signal ambiguity during PRD generation (a new prompt/structured-output surface, a new suspend point inside `sendUserMessage`'s flow rather than inside `approvePrd`'s step loop), which is design work beyond wiring the transport. Following this plan's own established practice for narrowing scope (DropdownV2, Tabs/Listview slots, layout-in-Update, the `plugin` query branch), it is deferred rather than half-built. The transport (`raiseInterrupt`/`interrupt-answer`) is written generically so `clarify_prd` is a second call site, not a second protocol, once that design work happens.

## Consequences

- **Interrupt × the step retry loop.** A timed-out interrupt clears `metadata.interrupt` before throwing, so `executeStepWithRetry`'s next attempt (`MAX_STEP_ATTEMPTS = 3`) raises a genuinely fresh interrupt — new id, a new `interrupt` SSE re-sent — rather than silently reusing the stale record (which would skip the SSE event and leave a reconnected client's card pointing at a dead id). This means a step that never gets answered can hold its SSE connection open for up to 3 × 30 minutes before failing, the same shape `awaitExternalTableConfirmation`'s confirmation gate already has today — not a regression this ADR introduces, but worth stating: V1 does not special-case "the human clearly isn't answering" into an earlier bail-out.
- `select_datasource` interrupts pause `approvePrd`'s existing SSE connection the same way a CreateTable confirmation does; the existing heartbeat is what keeps the connection alive across a human's response time, unchanged.
- The frontend gets one new SSE case (`interrupt`) and one new plain-`fetch` action (`interruptAnswer`), following the exact shape `step-awaiting-confirmation`/`confirm-step` already established (even though, per recon, that pair currently has no frontend consumer either — this ADR's UI is therefore the first real consumer of this event shape, not a copy of a working reference).
- Approve-PRD remains the only build-triggering approval gate (ADR-0001) — an interrupt only pauses *within* an already-approved run; it never substitutes for approval.
