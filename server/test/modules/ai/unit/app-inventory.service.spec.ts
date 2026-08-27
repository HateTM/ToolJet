// server/test/modules/ai/unit/app-inventory.service.spec.ts
import { AppInventoryService } from '@modules/ai/services/app-inventory.service';

const buildService = (overrides: Partial<Record<string, any>> = {}) => {
  const appsRepository = overrides.appsRepository ?? { findOneById: jest.fn().mockResolvedValue({ name: 'CRM' }) };
  const pageService = overrides.pageService ?? { findPagesForVersion: jest.fn().mockResolvedValue([]) };
  const dataQueryRepository = overrides.dataQueryRepository ?? { getMany: jest.fn().mockResolvedValue([]) };
  const aiConversationRepository = overrides.aiConversationRepository ?? {
    findAllByAppAndType: jest.fn().mockResolvedValue([]),
  };
  const aiConversationMessageRepository = overrides.aiConversationMessageRepository ?? {
    findMessageById: jest.fn(),
  };
  const stepRepository = overrides.stepRepository ?? { findByConversationId: jest.fn().mockResolvedValue([]) };

  const service = new AppInventoryService(
    appsRepository as any,
    pageService as any,
    dataQueryRepository as any,
    aiConversationRepository as any,
    aiConversationMessageRepository as any,
    stepRepository as any
  );

  return {
    service,
    appsRepository,
    pageService,
    dataQueryRepository,
    aiConversationRepository,
    aiConversationMessageRepository,
    stepRepository,
  };
};

/** @group platform */
describe('AppInventoryService.assemble', () => {
  it('lists every page with the type and name of each of its components', async () => {
    const { service, pageService } = buildService();
    pageService.findPagesForVersion.mockResolvedValue([
      {
        name: 'Orders',
        components: {
          'c-1': { name: 'orders_table', type: 'Table' },
          'c-2': { name: 'refresh_button', type: 'Button' },
        },
      },
      { name: 'Settings', components: {} },
    ]);

    const inventory = await service.assemble('app-1', 'version-1');

    expect(pageService.findPagesForVersion).toHaveBeenCalledWith('version-1');
    expect(inventory).toContain('- Orders: Table "orders_table", Button "refresh_button"');
    expect(inventory).toContain('- Settings (no components yet)');
  });

  it('omits layout and styling — a Learn conversation answers "what does my app do"', async () => {
    const { service, pageService } = buildService();
    pageService.findPagesForVersion.mockResolvedValue([
      {
        name: 'Orders',
        components: {
          'c-1': {
            name: 'orders_table',
            type: 'Table',
            styles: { borderRadius: { value: '12px' } },
            layouts: { desktop: { top: 40, left: 3, width: 25, height: 460 } },
          },
        },
      },
    ]);

    const inventory = await service.assemble('app-1', 'version-1');

    expect(inventory).not.toContain('borderRadius');
    expect(inventory).not.toContain('12px');
    expect(inventory).not.toContain('460');
  });

  it('lists the queries and the data sources they actually use, deduplicated', async () => {
    const { service, dataQueryRepository } = buildService();
    const tooljetDb = { id: 'ds-1', name: 'ToolJet Database', kind: 'tooljetdb' };
    dataQueryRepository.getMany.mockResolvedValue([
      { name: 'list_orders', options: { operation: 'list_rows' }, dataSource: tooljetDb },
      { name: 'list_customers', options: { operation: 'list_rows' }, dataSource: tooljetDb },
    ]);

    const inventory = await service.assemble('app-1', 'version-1');

    expect(dataQueryRepository.getMany).toHaveBeenCalledWith({ appVersionId: 'version-1' }, ['dataSource']);
    expect(inventory).toContain('- list_orders on ToolJet Database (list_rows)');
    expect(inventory).toContain('- list_customers on ToolJet Database (list_rows)');
    // One data source, listed once, even though two queries reference it.
    expect(inventory.match(/- ToolJet Database \(tooljetdb\)/g)).toHaveLength(1);
  });

  it('says so explicitly when the app is empty, rather than leaving sections blank', async () => {
    const { service } = buildService();

    const inventory = await service.assemble('app-1', 'version-1');

    expect(inventory).toContain('App: CRM');
    expect(inventory).toContain('Pages: none yet.');
    expect(inventory).toContain('Data sources: none in use.');
    expect(inventory).toContain('Queries: none yet.');
    expect(inventory).toContain('Past approved builds: none');
  });

  it('summarizes approved PRDs and what each one actually built', async () => {
    const { service, aiConversationRepository, stepRepository, aiConversationMessageRepository } = buildService();
    aiConversationRepository.findAllByAppAndType.mockResolvedValue([{ id: 'conv-1' }]);
    stepRepository.findByConversationId.mockResolvedValue([
      { messageId: 'prd-1', description: 'Create the orders table', status: 'succeeded' },
      { messageId: 'prd-1', description: 'Create the orders page', status: 'succeeded' },
      { messageId: 'prd-1', description: 'Create a chart', status: 'failed' },
    ]);
    aiConversationMessageRepository.findMessageById.mockResolvedValue({
      id: 'prd-1',
      content: 'Build an order tracker with a table of orders.',
    });

    const inventory = await service.assemble('app-1', 'version-1');

    expect(aiConversationRepository.findAllByAppAndType).toHaveBeenCalledWith('app-1', 'generate');
    expect(inventory).toContain('Build an order tracker with a table of orders.');
    expect(inventory).toContain('Built: Create the orders table; Create the orders page');
    // A failed step didn't change the app, so it isn't reported as built.
    expect(inventory).not.toContain('Create a chart');
  });

  it('ignores a PRD that was never approved — a conversation with no Steps against it', async () => {
    const { service, aiConversationRepository, stepRepository, aiConversationMessageRepository } = buildService();
    aiConversationRepository.findAllByAppAndType.mockResolvedValue([{ id: 'conv-1' }]);
    stepRepository.findByConversationId.mockResolvedValue([]);

    const inventory = await service.assemble('app-1', 'version-1');

    expect(aiConversationMessageRepository.findMessageById).not.toHaveBeenCalled();
    expect(inventory).toContain('Past approved builds: none');
  });

  it('truncates a long PRD so build history cannot crowd out the conversation itself', async () => {
    const { service, aiConversationRepository, stepRepository, aiConversationMessageRepository } = buildService();
    aiConversationRepository.findAllByAppAndType.mockResolvedValue([{ id: 'conv-1' }]);
    stepRepository.findByConversationId.mockResolvedValue([
      { messageId: 'prd-1', description: 'Create a table', status: 'succeeded' },
    ]);
    aiConversationMessageRepository.findMessageById.mockResolvedValue({ content: 'x'.repeat(5000) });

    const inventory = await service.assemble('app-1', 'version-1');

    expect(inventory).toContain('…');
    expect(inventory.length).toBeLessThan(2000);
  });

  it('falls back to a placeholder name for an app it cannot read', async () => {
    const { service, appsRepository } = buildService();
    appsRepository.findOneById.mockResolvedValue(null);

    await expect(service.assemble('app-1', 'version-1')).resolves.toContain('App: Untitled app');
  });
});
