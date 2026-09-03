import { FastifyInstance } from 'fastify';
import {
  buildEvaluateStage,
  buildFeaturePlannerStage,
  buildLldStage,
  buildPerEntityStage,
  buildStepGenerationStage,
  buildStepPlanStage,
  DefaultPipelineDeps,
  PipelineArtifacts,
  PipelineStage,
  runPipeline,
} from '../pipeline';
import { buildRealPipelineDeps } from '../pipeline/llm-deps';
import { createUsageRecorder } from '../pipeline/usage';
import { EffectiveLlmConfig } from '../config/provider';
import { abortOnClientDisconnect } from './client-disconnect';
import { classifyLlmError } from '../llm-errors';

/**
 * Request body for POST /generate/steps (ADR-0048). The caller posts an ALREADY
 * user-approved PRD — never a raw prompt — so classify and prd stages never run:
 * re-running them would silently regenerate a different PRD than the user approved.
 * `lld` is optional: supplied when the caller already has an LLD schema for the PRD.
 * `componentIndex` is the server-rendered "Existing components already in this app"
 * block the step prompts ground themselves against (same source the server's
 * in-process planner uses). `llm` is ADR-0038's per-request provider config, resolved
 * by the caller; `organizationId` threads through StageContext verbatim (ADR-0029:
 * the stateless engine makes no decision with it).
 */
export type GenerateStepsBody = {
  prd?: string;
  lld?: PipelineArtifacts['lld'];
  componentIndex?: string;
  organizationId?: string;
  llm?: EffectiveLlmConfig;
};

/** Test seam, same pattern as run-pipeline.ts's PipelineDepsFactory (minus SSE emit). */
export type GenerateStepsDepsFactory = () => DefaultPipelineDeps;

export function defaultGenerateStepsDepsFactory(): DefaultPipelineDeps {
  return buildRealPipelineDeps();
}

/**
 * POST /generate/steps — runs the approved-PRD pipeline (ADR-0048):
 * lld (skipped when supplied) -> feature-planner -> per-entity -> step-plan ->
 * step-generation -> evaluate, and returns the final artifacts as plain JSON.
 *
 * A separate route instead of a flag on POST /generate/run: the two wire contracts
 * differ (from-scratch prompt + SSE vs approved PRD + JSON), and /generate/run's
 * batch/eval consumers depend on its from-scratch semantics.
 *
 * AI SDK 6 (task 2a):
 *  - success responses gain an additive `usage` field — the cumulative
 *    { promptTokens, completionTokens, totalTokens } across all LLM calls of the
 *    run; present whenever at least one call was recorded.
 *  - a client disconnect aborts the run (no wasted tokens) and is answered with
 *    499 { error }, never a 500.
 *  - provider errors are classified by llm-errors.ts: retryable/unavailable ->
 *    503 { error, kind: 'provider_unavailable', retryable: true }, invalid request
 *    (4xx) -> 400 { error, kind: 'invalid_request' }, schema-invalid model output ->
 *    502 { error, kind: 'invalid_output' }. Anything unrecognized keeps the plain 500.
 */
export function registerGenerateStepsRoute(app: FastifyInstance, depsFactory: GenerateStepsDepsFactory) {
  app.post('/generate/steps', async (request, reply) => {
    const body = request.body as GenerateStepsBody | undefined;
    const { prd, lld, componentIndex, organizationId, llm } = body ?? {};

    const llmConfigValid =
      typeof llm === 'object' &&
      llm !== null &&
      typeof (llm as EffectiveLlmConfig).provider === 'string' &&
      typeof (llm as EffectiveLlmConfig).model === 'string' &&
      typeof (llm as EffectiveLlmConfig).apiKey === 'string';
    // A malformed caller-supplied lld would otherwise suppress the lld stage and blow up
    // downstream as a misleading 500 naming the wrong stage (code-review finding).
    const lldValid =
      lld === undefined ||
      (typeof lld === 'object' && lld !== null && Array.isArray((lld as { tables?: unknown }).tables));

    if (
      typeof prd !== 'string' ||
      prd.length === 0 ||
      !llmConfigValid ||
      !lldValid ||
      (componentIndex !== undefined && typeof componentIndex !== 'string') ||
      (organizationId !== undefined && typeof organizationId !== 'string')
    ) {
      reply.code(400);
      return {
        error:
          'prd (non-empty string), llm { provider, model, apiKey }, an optional lld { tables: [...] } and string componentIndex/organizationId are required',
      };
    }

    // Stop generating as soon as the client goes away — no wasted tokens. On a
    // disconnected client the response itself no longer matters; what matters is
    // that the abort reaches every LLM call through StageContext.signal.
    const controller = new AbortController();
    abortOnClientDisconnect(reply, controller);

    const deps = depsFactory();
    const usage = createUsageRecorder();
    const stages: PipelineStage[] = [
      ...(lld ? [] : [buildLldStage(deps.lld)]),
      buildFeaturePlannerStage(deps.featurePlanner),
      buildPerEntityStage(deps.perEntity),
      buildStepPlanStage(deps.stepPlan),
      buildStepGenerationStage(deps.stepGeneration),
      buildEvaluateStage(deps.evaluate),
    ];

    const initial: PipelineArtifacts = {
      prompt: '',
      prd,
      ...(componentIndex && { componentIndex }),
      ...(lld && { lld }),
    };

    try {
      const artifacts = await runPipeline(stages, initial, {
        organizationId: organizationId ?? '',
        llm: llm as EffectiveLlmConfig,
        signal: controller.signal,
        usage,
      });
      return { artifacts, ...(usage.isEmpty() ? {} : { usage: usage.total() }) };
    } catch (error) {
      app.log.error(error);
      const stageName =
        typeof error === 'object' && error !== null && 'stageName' in error
          ? (error as { stageName?: string }).stageName
          : undefined;
      const classified = classifyLlmError(error);
      reply.code(classified?.statusCode ?? (controller.signal.aborted ? 499 : 500));
      return {
        error: classified?.message ?? (error instanceof Error ? error.message : 'Generation failed'),
        ...(stageName && { stage: stageName }),
        ...(classified && { kind: classified.kind, retryable: classified.retryable }),
        ...(controller.signal.aborted && { aborted: true }),
      };
    }
  });
}
