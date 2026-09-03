import { APICallError, NoObjectGeneratedError, RetryError } from 'ai';
import { classifyLlmError } from '../src/llm-errors';
import { PipelineStageError } from '../src/pipeline/orchestrator';

/** A provider 500/429/network failure the engine cannot fix by changing the request. */
function apiError(statusCode?: number): APICallError {
  return new APICallError({
    message: 'upstream exploded',
    url: 'https://api.provider.internal/v1/chat?token=super-secret',
    requestBodyValues: { apiKey: 'sk-leaky' },
    statusCode,
    isRetryable: statusCode === undefined || statusCode >= 500 || statusCode === 429,
  });
}

describe('classifyLlmError', () => {
  it('maps a provider 5xx to 503 provider_unavailable with a fixed retryable message', () => {
    const classified = classifyLlmError(apiError(503));
    expect(classified).toMatchObject({
      kind: 'provider_unavailable',
      statusCode: 503,
      retryable: true,
      message: 'LLM provider is temporarily unavailable; retry shortly.',
    });
  });

  it('maps a 429 rate limit to 503 provider_unavailable (retryable)', () => {
    expect(classifyLlmError(apiError(429))).toMatchObject({ kind: 'provider_unavailable', statusCode: 503 });
  });

  it('maps a network-level APICallError with no status code to 503', () => {
    expect(classifyLlmError(apiError(undefined))).toMatchObject({ kind: 'provider_unavailable', statusCode: 503 });
  });

  it('maps a provider 4xx (other than 429) to 400 invalid_request with a sanitized message', () => {
    const classified = classifyLlmError(apiError(401));
    expect(classified).toMatchObject({ kind: 'invalid_request', statusCode: 400, retryable: false });
    // Never leak the endpoint URL or the request payload (keys included).
    expect(classified!.message).not.toContain('api.provider.internal');
    expect(classified!.message).not.toContain('sk-leaky');
    expect(classified!.message).toContain('401');
  });

  it('sees through RetryError.errors to the wrapped APICallError', () => {
    const retry = new RetryError({ message: 'failed after retries', reason: 'maxRetriesExceeded', errors: [apiError(429)] });
    expect(classifyLlmError(retry)).toMatchObject({ kind: 'provider_unavailable', statusCode: 503 });
  });

  it('sees through PipelineStageError.cause to the wrapped APICallError', () => {
    const stageError = new PipelineStageError('lld', apiError(500));
    const classified = classifyLlmError(stageError);
    expect(classified).toMatchObject({ kind: 'provider_unavailable', statusCode: 503 });
    // The route keeps the stage name for its own event; the mapper only classifies.
    expect(stageError.stageName).toBe('lld');
  });

  it('maps NoObjectGeneratedError (schema-invalid model output) to 502 invalid_output', () => {
    const noObject = new NoObjectGeneratedError({ message: 'No object generated.', response: {}, usage: {}, finishReason: 'stop' });
    expect(classifyLlmError(noObject)).toMatchObject({
      kind: 'invalid_output',
      statusCode: 502,
      retryable: true,
    });
  });

  it('maps AbortError to 499 aborted', () => {
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(classifyLlmError(abort)).toMatchObject({ kind: 'aborted', statusCode: 499 });
  });

  it('maps an aborted error wrapped in a PipelineStageError to 499 too', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyLlmError(new PipelineStageError('prd', abort))).toMatchObject({ kind: 'aborted', statusCode: 499 });
  });

  it('returns null for unrecognized errors so callers keep their 500 fallback', () => {
    expect(classifyLlmError(new Error('LLM provider exploded'))).toBeNull();
    expect(classifyLlmError('a string')).toBeNull();
  });
});
