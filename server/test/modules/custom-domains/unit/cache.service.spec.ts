// server/test/modules/custom-domains/unit/cache.service.spec.ts

import { CustomDomainCacheService } from 'src/modules/custom-domains/cache.service';

function buildRedisClient() {
  return {
    pipeline: jest.fn().mockReturnValue({
      del: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    }),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

function buildService(overrides: { repositoryFind?: jest.Mock; repositoryFindPending?: jest.Mock } = {}) {
  const redisClient = buildRedisClient();
  const redisService = { getClient: jest.fn().mockReturnValue(redisClient) } as any;
  const repository = {
    find: overrides.repositoryFind ?? jest.fn().mockResolvedValue([]),
    findPendingDomains: overrides.repositoryFindPending ?? jest.fn().mockResolvedValue([]),
  } as any;
  const service = new CustomDomainCacheService(repository, redisService);
  return { service, redisClient, repository };
}

describe('CustomDomainCacheService', () => {
  // Issue #173: onModuleInit used to fire-and-forget its Redis seeding calls,
  // so it returned (and the module reported "initialized") before those calls
  // settled. A short-lived app context (e.g. a data migration's own
  // NestFactory.createApplicationContext) could then close mid-call, racing
  // RedisService's disconnect against an in-flight command. onModuleInit must
  // not resolve until both seeding calls have settled.
  it('onModuleInit resolves only after both Redis seeding calls have settled', async () => {
    const { service, repository } = buildService();
    let resolveFind: () => void;
    repository.find.mockReturnValue(
      new Promise((resolve) => {
        resolveFind = () => resolve([]);
      })
    );

    let settled = false;
    const initPromise = service.onModuleInit().then(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFind();
    await initPromise;
    expect(settled).toBe(true);
  });

  it('onModuleInit does not reject when a seeding call fails', async () => {
    const { service, repository } = buildService({
      repositoryFind: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
