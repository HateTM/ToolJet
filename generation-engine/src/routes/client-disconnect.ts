import { FastifyReply } from 'fastify';

/**
 * Aborts `controller` when the client connection closes (task 2a abort propagation).
 *
 * Deliberately wired to the *hijacked response's* `close` event rather than
 * `request.raw`'s: after Fastify consumes the request body (it does, to JSON-parse it,
 * before the handler runs) the `IncomingMessage` emits its own stream `close` — Node
 * stream semantics — which would abort every run before generation even starts. The
 * `ServerResponse`'s `close` fires on a premature client disconnect (what we want) and
 * again after our own `end()` (harmless: generation is already finished by then).
 */
export function abortOnClientDisconnect(reply: FastifyReply, controller: AbortController): void {
  reply.raw.on('close', () => controller.abort());
}
