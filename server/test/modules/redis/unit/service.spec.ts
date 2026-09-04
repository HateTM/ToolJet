// server/test/modules/redis/unit/service.spec.ts

jest.mock('ioredis', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      quit: jest.fn(),
      disconnect: jest.fn(),
    })),
  };
});

import { RedisService } from 'src/modules/redis/service';

function buildTransactionLogger() {
  return {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  } as any;
}

describe('RedisService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  // Issue #173: onModuleDestroy used to call the immediate `disconnect()`,
  // which races in-flight commands (e.g. CustomDomainCacheService's
  // fire-and-forget onModuleInit calls) and crashed the whole process when a
  // short-lived app context (db:setup) tore down while a command was still
  // in flight. onModuleDestroy must prefer the graceful `quit()`.
  it('gracefully quits the client on module destroy instead of disconnecting immediately', async () => {
    const transactionLogger = buildTransactionLogger();
    const service = new RedisService(transactionLogger);
    service.onModuleInit();
    const client = service.getClient();
    (client.quit as jest.Mock).mockResolvedValue('OK');

    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('falls back to disconnect() if quit() fails', async () => {
    const transactionLogger = buildTransactionLogger();
    const service = new RedisService(transactionLogger);
    service.onModuleInit();
    const client = service.getClient();
    (client.quit as jest.Mock).mockRejectedValue(new Error('connection already closed'));

    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does nothing if the client was never initialized', async () => {
    const transactionLogger = buildTransactionLogger();
    const service = new RedisService(transactionLogger);

    await expect(service.onModuleDestroy()).resolves.not.toThrow();
  });
});
