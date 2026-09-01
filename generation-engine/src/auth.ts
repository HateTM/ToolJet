import { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'crypto';

/**
 * Shared-secret bearer auth for the engine's HTTP endpoints (ticket #114,
 * ADR-0032). ADR-0032 relies on network isolation (no host-published port),
 * but any container on the shared `external: true` network could otherwise
 * invoke unauthenticated LLM generation at the operator's token expense.
 * `ENGINE_API_KEY` is the same secret the ToolJet server sends from
 * `generation-engine-client.ts`.
 *
 * Fail closed: with `ENGINE_API_KEY` unset on the engine, every protected
 * request is rejected — never silently allowed — so a misconfigured deploy
 * is loud, not open. The env var is read per request so a restart isn't
 * needed to pick up a rotated key.
 */
export async function requireEngineApiKey(request: FastifyRequest, reply: FastifyReply) {
  const expected = process.env.ENGINE_API_KEY;

  if (!expected) {
    reply.code(503);
    return reply.send({ error: 'ENGINE_API_KEY is not configured on the generation engine' });
  }

  const header = request.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  // Constant-time compare so a wrong token is indistinguishable from a
  // missing one and the comparison leaks no timing signal.
  const matches = provided.length === expected.length && timingSafeEqual(Buffer.from(provided), Buffer.from(expected));

  if (!matches) {
    reply.code(401);
    return reply.send({ error: 'unauthorized' });
  }
}
