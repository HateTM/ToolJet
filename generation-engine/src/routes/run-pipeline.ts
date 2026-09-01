import { FastifyInstance, FastifyReply } from 'fastify';
import { streamText } from 'ai';
import { buildDefaultPipeline, DefaultPipelineDeps, PipelineArtifacts, PipelineStage, runPipeline } from '../pipeline';
import { buildRealPipelineDeps } from '../pipeline/llm-deps';
import { PRD_SYSTEM_PROMPT } from '../prompts';
import { resolveLanguageModel, EffectiveLlmConfig } from '../config/provider';

/**
 * Request body for POST /generate/run.
 *
 * `llm` is the per-request provider config (ADR-0038): the server resolves the
 * org's BYOK/env fallback BEFORE invoking the engine and posts the effective
 * result — the engine never reads organization_ai_keys or env vars for it.
 * `organizationId` is threaded through StageContext verbatim for server-owned
 * concerns; the stateless engine (ADR-0029) itself makes no decision with it.
 */
export type RunPipelineBody = {
  prompt?: string;
  organizationId?: string;
  llm?: EffectiveLlmConfig;
};

/**
 * SSE progress emitter the route hands to the deps factory and the stage
 * wrapper. Kept as a plain function so tests can capture events without a
 * real reply.
 */
export type EmitFn = (event: string, data: unknown) => void;

/**
 * Builds the pipeline deps for one run. The `emit` parameter lets the PRD
 * half stream its tokens to the caller as they are produced. Test seam (same
 * pattern as #91's `streamPrd`): tests inject a factory whose deps are fake
 * LLM halves, so route tests never touch the network.
 */
export type PipelineDepsFactory = (emit: EmitFn) => DefaultPipelineDeps;

/**
 * The production deps factory: the real LLM-calling halves from
 * llm-deps.ts (#110), with the PRD half swapped for a *streaming* variant of
 * the same call — same PRD system prompt from the #93 library, same
 * `resolveLanguageModel(ctx.llm)` resolution, but `streamText` instead of
 * `generateText`, each delta emitted as a `prd-chunk` SSE event before the
 * stage resolves with the full text. This is what ticket #113's AC means by
 * "the PRD artifact streamed token-by-token as produced"; the non-streaming
 * `deps.prd` from llm-deps.ts stays untouched for internal/batch callers
 * (ADR-0028 note, 2026-09-01).
 */
export function defaultPipelineDepsFactory(emit: EmitFn): DefaultPipelineDeps {
  const deps = buildRealPipelineDeps();

  deps.prd = {
    async generatePrd(input, ctx) {
      // Same prompt pair as llm-deps.ts's non-streaming prd half: the PRD
      // system prompt from the #93 library, the stage input as the user
      // message — only the streaming differs.
      const result = streamText({
        model: resolveLanguageModel(ctx.llm),
        messages: [
          { role: 'system', content: PRD_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
      });

      let full = '';
      for await (const chunk of result.textStream) {
        full += chunk;
        emit('prd-chunk', { content: chunk });
      }
      return full;
    },
  };

  return deps;
}

function writeSSE(reply: FastifyReply, type: string, data: unknown) {
  reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * POST /generate/run — ticket #113: runs the full ADR-0028 pipeline
 * (classify -> PRD -> LLD -> feature-planner -> per-entity -> step-plan ->
 * evaluate) end-to-end against a real user prompt and streams progress.
 *
 * Why a separate route instead of extending POST /generate/prd: the two wire
 * contracts differ. #91's route is flat PRD generation (messages in, chunks
 * out); this one takes a prompt + EffectiveLlmConfig and adds stage-progress
 * events and a structured final-artifacts payload. Keeping them apart lets
 * #91's route stay the streaming PRD path verbatim (ADR-0028 note) and keeps
 * the rebase onto #91 textual rather than semantic.
 *
 * Wire contract with the server-side proxy (mirrors #91's conventions):
 *  - `stage`      (repeated): { stage: string } — fired just before each
 *    stage actually runs; never fired for stages the orchestrator's
 *    unsupported-classification short-circuit skips (#115).
 *  - `prd-chunk`  (repeated): { content: string } — PRD deltas as produced.
 *  - `engine-done` (once, success only): { artifacts: PipelineArtifacts } —
 *    the terminal structured payload carrying ALL final artifacts
 *    (classification, prd, lld, featurePlan, entityToolCalls, stepPlan,
 *    evaluation). An `unsupported` classification is a normal outcome here,
 *    not an error: the short-circuited artifacts come back on engine-done
 *    and the caller presents the classification to the user (#115).
 *  - `engine-error` (once, failure only): { message, stage? } — the failing
 *    stage name from PipelineStageError when the failure came from a stage.
 *
 * A request missing `prompt` or a usable `llm` config is rejected with a
 * plain 400 BEFORE the SSE headers are written, so the server's error path
 * doesn't have to parse an SSE stream to find a validation failure (same
 * rule as #91's route).
 */
export function registerRunPipelineRoute(app: FastifyInstance, depsFactory: PipelineDepsFactory) {
  app.post('/generate/run', async (request, reply) => {
    const body = request.body as RunPipelineBody | undefined;
    const { prompt, organizationId, llm } = body ?? {};

    const llmConfigValid =
      typeof llm === 'object' &&
      llm !== null &&
      typeof (llm as EffectiveLlmConfig).provider === 'string' &&
      typeof (llm as EffectiveLlmConfig).model === 'string' &&
      typeof (llm as EffectiveLlmConfig).apiKey === 'string';

    if (typeof prompt !== 'string' || prompt.length === 0 || !llmConfigValid) {
      reply.code(400);
      return {
        error: 'prompt (non-empty string) and llm { provider, model, apiKey } are required',
      };
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.hijack();

    const emit: EmitFn = (event, data) => writeSSE(reply, event, data);

    try {
      const deps = depsFactory(emit);

      // Wrap each stage to emit a progress event just before it actually
      // runs. Stages skipped by the unsupported-classification short-circuit
      // never have run() called, so they never emit.
      const stages: PipelineStage[] = buildDefaultPipeline(deps).map((stage) => ({
        name: stage.name,
        run: async (artifacts: PipelineArtifacts, ctx) => {
          emit('stage', { stage: stage.name });
          return stage.run(artifacts, ctx);
        },
      }));

      const artifacts = await runPipeline(
        stages,
        { prompt },
        {
          organizationId: organizationId ?? '',
          llm: llm as EffectiveLlmConfig,
        }
      );

      emit('engine-done', { artifacts });
    } catch (error) {
      app.log.error(error);
      const stageName =
        typeof error === 'object' && error !== null && 'stageName' in error
          ? (error as { stageName?: string }).stageName
          : undefined;
      emit('engine-error', {
        message: error instanceof Error ? error.message : 'Generation failed',
        ...(stageName && { stage: stageName }),
      });
    } finally {
      reply.raw.end();
    }
  });
}
