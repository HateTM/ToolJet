import { APICallError, NoObjectGeneratedError } from 'ai';

/**
 * Provider error classification (AI SDK 6 task 2a). Before the upgrade every LLM
 * failure surfaced to callers as a generic 500 with the raw error message — leaking
 * provider URLs/response bodies and treating rate limits and bad requests alike. This
 * mapper walks the error's `cause` chain (stage failures are wrapped in
 * `PipelineStageError`, and the SDK wraps provider failures in `RetryError`) and
 * classifies the first recognized AI SDK error:
 *
 *  - retryable/unavailable (HTTP >= 500, 429, `isRetryable`, or a network-level
 *    `APICallError` with no status) -> 503 with a fixed short message;
 *  - invalid request (any other 4xx) -> 400 with a sanitized message — status code
 *    only, never the URL, response body, or headers, so keys/endpoint URLs cannot leak;
 *  - structurally invalid model output (`NoObjectGeneratedError` — the structured-
 *    output path's schema validation failing) -> 502: the upstream model produced
 *    unusable content, distinct from both buckets above;
 *  - client aborts (`AbortError`) -> 499 ("client closed request"), not an error at
 *    all from the caller's point of view.
 *
 * Returns null for anything unrecognized — callers keep their existing 500 fallback.
 */
export type LlmErrorKind = 'provider_unavailable' | 'invalid_request' | 'invalid_output' | 'aborted';

export interface ClassifiedLlmError {
  kind: LlmErrorKind;
  /** HTTP status the route should respond with. */
  statusCode: number;
  /** Sanitized message safe to put on the wire. */
  message: string;
  retryable: boolean;
}

export const PROVIDER_UNAVAILABLE_MESSAGE = 'LLM provider is temporarily unavailable; retry shortly.';
export const INVALID_REQUEST_MESSAGE_PREFIX = 'LLM provider rejected the request';
export const INVALID_OUTPUT_MESSAGE = 'LLM generated an output that failed schema validation.';
export const ABORTED_MESSAGE = 'Generation aborted: the client disconnected.';

/** Collects an error plus its `cause` chain, innermost-first order preserved. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const queue: unknown[] = [error];
  let depth = 0;
  while (queue.length > 0 && depth < 20) {
    const current = queue.shift()!;
    if (!(current instanceof Error)) continue;
    chain.push(current);
    depth++;
    // The SDK's RetryError keeps its attempts in `errors`, not `cause`.
    const errors = (current as { errors?: unknown }).errors;
    if (Array.isArray(errors)) queue.push(...errors);
    queue.push((current as { cause?: unknown }).cause);
  }
  return chain;
}

function isAbortError(candidate: unknown): boolean {
  return candidate instanceof Error && candidate.name === 'AbortError';
}

export function classifyLlmError(error: unknown): ClassifiedLlmError | null {
  const chain = errorChain(error);

  // Aborts first: an abort may wrap other error shapes, and it wins regardless.
  if (chain.some(isAbortError)) {
    return { kind: 'aborted', statusCode: 499, message: ABORTED_MESSAGE, retryable: false };
  }

  for (const candidate of chain) {
    if (APICallError.isInstance(candidate)) {
      const statusCode = candidate.statusCode;
      const invalidRequest =
        typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 && statusCode !== 429;
      if (invalidRequest) {
        return {
          kind: 'invalid_request',
          statusCode: 400,
          message: `${INVALID_REQUEST_MESSAGE_PREFIX} (HTTP ${statusCode})`,
          retryable: false,
        };
      }
      // 5xx, 429, or a network-level APICallError with no status at all.
      return { kind: 'provider_unavailable', statusCode: 503, message: PROVIDER_UNAVAILABLE_MESSAGE, retryable: true };
    }
    if (NoObjectGeneratedError.isInstance(candidate)) {
      return { kind: 'invalid_output', statusCode: 502, message: INVALID_OUTPUT_MESSAGE, retryable: true };
    }
  }

  return null;
}
