// server/test/modules/apps/unit/apps.subscriber.spec.ts

import { AppsSubscriber } from 'src/modules/apps/subscribers/apps.subscriber';
import { App } from 'src/entities/app.entity';
import { APP_TYPES } from '@modules/apps/constants';

function buildSubscriber(defaultBranch: unknown = null) {
  const appVersionRepository = { findOne: jest.fn().mockResolvedValue(null) } as any;
  const appRepository = {} as any;
  const manager = { findOne: jest.fn().mockResolvedValue(defaultBranch) };
  const datasourceRepository = { subscribers: [], manager } as any;
  const subscriber = new AppsSubscriber(appVersionRepository, appRepository, datasourceRepository);
  return { subscriber, appVersionRepository, manager };
}

function buildApp(overrides: Partial<App> = {}): App {
  const app = new App();
  Object.assign(app, { id: 'app-1', type: APP_TYPES.FRONT_END, ...overrides });
  return app;
}

describe('AppsSubscriber.afterLoad', () => {
  // Issue found live-testing the AI Builder end-to-end: VersionRepository.createOne's
  // `manager.findOne(App, { where: { id: appId }, select: { id: true, type: true } })`
  // parent-type check loads a partial App with organizationId undefined. Querying
  // WorkspaceBranch with an undefined organizationId in its `where` throws under
  // TypeORM 1.0's stricter where-value validation (post-#135 regression) — every
  // single `POST /api/apps` 500'd on this before the fix.
  it('does not query WorkspaceBranch when organizationId was not selected (partial load)', async () => {
    const { subscriber, manager, appVersionRepository } = buildSubscriber();
    const app = buildApp({ organizationId: undefined });

    await subscriber.afterLoad(app);

    expect(manager.findOne).not.toHaveBeenCalled();
    // Falls through to the non-branch editingVersion lookup, same as the isWorkflow path.
    expect(appVersionRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ appId: 'app-1' }) })
    );
  });

  it('still queries WorkspaceBranch when organizationId is present (full load)', async () => {
    const { subscriber, manager } = buildSubscriber();
    const app = buildApp({ organizationId: 'org-1' });

    await subscriber.afterLoad(app);

    expect(manager.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ where: { organizationId: 'org-1', isDefault: true } })
    );
  });

  it('skips the WorkspaceBranch check for workflows regardless of organizationId', async () => {
    const { subscriber, manager } = buildSubscriber();
    const app = buildApp({ type: APP_TYPES.WORKFLOW, organizationId: 'org-1' });

    await subscriber.afterLoad(app);

    expect(manager.findOne).not.toHaveBeenCalled();
  });

  it('returns early without touching editingVersion when git is enabled', async () => {
    const { subscriber, appVersionRepository } = buildSubscriber({ id: 'branch-1' });
    const app = buildApp({ organizationId: 'org-1' });

    await subscriber.afterLoad(app);

    expect(appVersionRepository.findOne).not.toHaveBeenCalled();
    expect((app as any).editingVersion).toBeUndefined();
  });

  it('ignores non-App entities', async () => {
    const { subscriber, manager } = buildSubscriber();

    await subscriber.afterLoad({ organizationId: undefined });

    expect(manager.findOne).not.toHaveBeenCalled();
  });
});
