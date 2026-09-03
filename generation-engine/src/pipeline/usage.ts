import { LlmCallUsage, UsageRecorder } from './types';

export type { LlmCallUsage, UsageRecorder } from './types';

/**
 * Token-usage plumbing for the AI SDK 6 upgrade (task 2a): the SDK reports usage as
 * `inputTokens`/`outputTokens`/`totalTokens` (v4's `promptTokens`/`completionTokens`
 * were renamed in v5), while the engine's wire contract keeps the v4-era field names.
 * This module is the only place the two vocabularies meet.
 */

/** The shape of `generateText`/`streamText` result `usage` (structural, no type import). */
export interface AiSdkUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Normalizes one AI SDK usage object into the engine's wire shape (missing counts → 0). */
export function normalizeLlmUsage(usage: AiSdkUsage | undefined): LlmCallUsage {
  const promptTokens = usage?.inputTokens ?? 0;
  const completionTokens = usage?.outputTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: usage?.totalTokens ?? promptTokens + completionTokens,
  };
}

/** Sums per-call usage entries into the cumulative wire shape. */
export function sumLlmUsage(calls: LlmCallUsage[]): LlmCallUsage {
  return calls.reduce(
    (total, call) => ({
      promptTokens: total.promptTokens + call.promptTokens,
      completionTokens: total.completionTokens + call.completionTokens,
      totalTokens: total.totalTokens + call.totalTokens,
    }),
    { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  );
}

/**
 * A usage recorder that keeps every per-call entry (routes expose the cumulative total
 * additively; /generate/run additionally emits each call as its own SSE event). The
 * optional `onRecord` hook fires per call — the SSE route uses it to emit the event
 * inline instead of polling the log.
 */
export function createUsageRecorder(
  onRecord?: (usage: LlmCallUsage) => void
): UsageRecorder & { calls: LlmCallUsage[]; total(): LlmCallUsage; isEmpty(): boolean } {
  const calls: LlmCallUsage[] = [];
  return {
    calls,
    record(usage: LlmCallUsage) {
      calls.push(usage);
      onRecord?.(usage);
    },
    total() {
      return sumLlmUsage(calls);
    },
    isEmpty() {
      return calls.length === 0;
    },
  };
}
