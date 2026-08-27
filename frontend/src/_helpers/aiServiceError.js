/**
 * Extracts the human-readable line out of whatever an `aiService` call rejected with.
 *
 * `handleAITextResponse` throws `{ error, data, statusCode }`, while a dropped connection
 * rejects with a plain Error; every AI affordance that surfaces a failure in its own popover —
 * `Fix with AI`, `Copilot` — has to understand both, so the decoding lives here once.
 *
 * Its own module rather than a named export from `ai.service.js`: that file pulls in `config`
 * and the SSE client, so importing it from a test would drag both in, and every spec that
 * mocks `aiService` would have to hand-roll a copy of this function to keep it working.
 *
 * Returns `undefined` when the rejection carries no message. The caller supplies the wording
 * for that case, because only the caller is in a position to translate it.
 */
export const readAiServiceError = (error) => error?.error || error?.data?.message || error?.message || undefined;
