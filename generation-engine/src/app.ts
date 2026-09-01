import Fastify, { FastifyInstance } from 'fastify';

/**
 * Builds (but does not start) the Fastify app.
 *
 * Kept separate from `listen()` (see server.ts) so tests can exercise routes
 * via `app.inject()` without binding a real port. No pipeline/LLM logic yet —
 * ticket #90 is scaffold only; per ADR-0029 the engine is stateless (no
 * ORM/RBAC/DB), so this factory takes no dependencies today.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  return app;
}
