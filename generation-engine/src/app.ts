import Fastify, { FastifyInstance } from 'fastify';
import { registerGeneratePrdRoute, defaultStreamPrd, StreamPrdFn } from './routes/generate-prd';

export type BuildAppOptions = {
  /**
   * Injection seam for the PRD generation call (ticket #91). Defaults to the
   * real `streamText`/AI SDK call (`defaultStreamPrd`); tests pass a stub
   * generator so route tests never touch the network. Optional and
   * backwards-compatible — existing `buildApp()` callers (health check) are
   * unaffected.
   */
  streamPrd?: StreamPrdFn;
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

  registerGeneratePrdRoute(app, options.streamPrd ?? defaultStreamPrd);

  return app;
}
