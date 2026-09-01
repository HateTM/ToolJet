export interface ListenConfig {
  host: string;
  port: number;
}

/**
 * Resolves the address the Fastify app binds to.
 *
 * Defaults to `0.0.0.0`, not `127.0.0.1`/`localhost` — this service is
 * reached over the shared internal docker network described in ADR-0032
 * (`tooljet-ce:local` -> `generation-engine` by hostname, no host port
 * published). Binding to loopback would make it unreachable from any other
 * container regardless of how the network/DNS side is configured.
 */
export function resolveListenConfig(env: Record<string, string | undefined>): ListenConfig {
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT) || 3100,
  };
}
