import Fastify, { FastifyInstance } from 'fastify';
import { registerGeneratePrdRoute, defaultStreamPrd, StreamPrdFn } from './routes/generate-prd';
import { registerRunPipelineRoute, defaultPipelineDepsFactory, PipelineDepsFactory } from './routes/run-pipeline';
import {
  registerGenerateStepsRoute,
  defaultGenerateStepsDepsFactory,
  GenerateStepsDepsFactory,
} from './routes/generate-steps';
import { requireEngineApiKey } from './auth';

export type BuildAppOptions = {
  /**
   * Injection seam for the PRD generation call (ticket #91). Defaults to the
   * real `streamText`/AI SDK call (`defaultStreamPrd`); tests pass a stub
   * generator so route tests never touch the network. Optional and
   * backwards-compatible — existing `buildApp()` callers (health check) are
   * unaffected.
   */
  streamPrd?: StreamPrdFn;
  /**
   * Injection seam for the full pipeline run (ticket #113). Defaults to
   * `defaultPipelineDepsFactory` (the real LLM-calling halves from
   * llm-deps.ts, with a streaming PRD half); tests pass a factory whose deps
   * are fake LLM halves so route tests never touch the network.
   */
  pipelineDepsFactory?: PipelineDepsFactory;
  /**
   * Injection seam for the approved-PRD step pipeline (ADR-0048). Defaults to
   * `defaultGenerateStepsDepsFactory`; tests pass a factory whose deps are fake
   * LLM halves so route tests never touch the network.
   */
  generateStepsDepsFactory?: GenerateStepsDepsFactory;
};

/**
 * Builds (but does not start) the Fastify app.
 *
 * Kept separate from `listen()` (see server.ts) so tests can exercise routes
 * via `app.inject()` without binding a real port. Per ADR-0029 the engine is
 * stateless (no ORM/RBAC/DB); `options` is purely a test seam, not
 * request-scoped or persisted state.
 */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Bearer-token auth (ticket #114): applies to every endpoint except
  // /health, which Docker healthchecks probe without credentials and which
  // exposes no LLM capability worth guarding. Covers POST /generate/prd (#91),
  // POST /generate/run (#113) and POST /generate/steps (ADR-0048) alike.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health')) {
      return;
    }
    await requireEngineApiKey(request, reply);
  });

  registerGeneratePrdRoute(app, options.streamPrd ?? defaultStreamPrd);
  registerRunPipelineRoute(app, options.pipelineDepsFactory ?? defaultPipelineDepsFactory);
  registerGenerateStepsRoute(app, options.generateStepsDepsFactory ?? defaultGenerateStepsDepsFactory);

  return app;
}
