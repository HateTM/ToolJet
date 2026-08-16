// server/test/modules/ai/unit/agents.service.spec.ts
import { AgentsService } from '@modules/ai/services/agents.service';

const buildMockTooljetDbTableOperationsService = () => ({
  perform: jest.fn(),
});

const buildMockPageService = () => ({
  createPage: jest.fn(),
});

const buildMockComponentsService = () => ({
  create: jest.fn(),
});

const buildMockDataQueryRepository = () => ({
  createOne: jest.fn(),
});

const buildMockDataSourcesRepository = () => ({
  getStaticDataSourceByKind: jest.fn(),
});

const buildAgentsService = (overrides: Partial<Record<string, any>> = {}) => {
  const tooljetDbTableOperationsService =
    overrides.tooljetDbTableOperationsService ?? buildMockTooljetDbTableOperationsService();
  const pageService = overrides.pageService ?? buildMockPageService();
  const componentsService = overrides.componentsService ?? buildMockComponentsService();
  const dataQueryRepository = overrides.dataQueryRepository ?? buildMockDataQueryRepository();
  const dataSourcesRepository = overrides.dataSourcesRepository ?? buildMockDataSourcesRepository();

  const service = new AgentsService(
    tooljetDbTableOperationsService as any,
    pageService as any,
    componentsService as any,
    dataQueryRepository as any,
    dataSourcesRepository as any
  );

  return {
    service,
    tooljetDbTableOperationsService,
    pageService,
    componentsService,
    dataQueryRepository,
    dataSourcesRepository,
  };
};

/** @group platform */
describe('AgentsService.CreateTable', () => {
  it("delegates to TooljetDbTableOperationsService.perform with the 'create_table' action", async () => {
    const { service, tooljetDbTableOperationsService } = buildAgentsService();
    tooljetDbTableOperationsService.perform.mockResolvedValue({ id: 'tjdb-uuid', table_name: 'customers' });

    const tables = {
      table_name: 'customers',
      columns: [
        {
          column_name: 'id',
          data_type: 'serial',
          constraints_type: { is_primary_key: true, is_not_null: true, is_unique: true },
        },
      ],
    };

    const result = await service.CreateTable('org-1', tables);

    expect(tooljetDbTableOperationsService.perform).toHaveBeenCalledWith('org-1', 'create_table', tables);
    expect(result).toEqual({ id: 'tjdb-uuid', table_name: 'customers' });
  });

  it('propagates errors from the underlying table-creation service as-is (e.g. missing primary key)', async () => {
    const { service, tooljetDbTableOperationsService } = buildAgentsService();
    tooljetDbTableOperationsService.perform.mockRejectedValue(new Error('Primary key is mandatory'));

    await expect(service.CreateTable('org-1', { table_name: 'x', columns: [] })).rejects.toThrow(
      'Primary key is mandatory'
    );
  });
});

/** @group platform */
describe('AgentsService.CreateComponent', () => {
  it('creates a Page via PageService.createPage, generating an id/handle', async () => {
    const { service, pageService } = buildAgentsService();
    pageService.createPage.mockResolvedValue({ id: 'page-1', name: 'Orders' });

    const result = await service.CreateComponent('version-1', 'org-1', 'Page', { name: 'Orders' });

    expect(pageService.createPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String), name: 'Orders', handle: 'orders', index: 0 }),
      'version-1',
      'org-1'
    );
    expect(result).toEqual({ id: 'page-1', name: 'Orders' });
  });

  it('slugifies non-alphanumeric characters into the page handle', async () => {
    const { service, pageService } = buildAgentsService();
    pageService.createPage.mockResolvedValue({ id: 'page-2', name: 'Support Tickets!' });

    await service.CreateComponent('version-1', 'org-1', 'Page', { name: 'Support Tickets!' });

    expect(pageService.createPage).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'support-tickets' }),
      'version-1',
      'org-1'
    );
  });

  it('creates a Table component bound to the given query via ComponentsService.create', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    const result = await service.CreateComponent('version-1', 'org-1', 'Table', {
      pageId: 'page-1',
      title: 'Orders table',
      queryName: 'list_orders',
    });

    expect(componentsService.create).toHaveBeenCalledTimes(1);
    const [componentDiff, pageId, appVersionId] = componentsService.create.mock.calls[0];
    expect(pageId).toBe('page-1');
    expect(appVersionId).toBe('version-1');

    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.type).toBe('Table');
    expect(definition.properties.dataSourceSelector.value).toBe('rawJson');
    expect(definition.properties.data.value).toBe('{{queries.list_orders.data}}');
    expect(definition.properties.autogenerateColumns.value).toBe(true);
    expect(definition.layouts.desktop).toEqual({ top: 0, left: 0, width: 25, height: 460 });

    expect(result).toMatchObject({ pageId: 'page-1', type: 'Table', queryName: 'list_orders' });
  });

  it('throws for an unrecognized component type without calling PageService/ComponentsService', async () => {
    const { service, pageService, componentsService } = buildAgentsService();

    await expect(service.CreateComponent('version-1', 'org-1', 'Form', {})).rejects.toThrow(
      /unsupported component type/i
    );
    expect(pageService.createPage).not.toHaveBeenCalled();
    expect(componentsService.create).not.toHaveBeenCalled();
  });
});

/** @group platform */
describe('AgentsService.CreateQuery', () => {
  it("looks up the org's built-in ToolJet DB data source and creates the query against it", async () => {
    const { service, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1', kind: 'tooljetdb' });
    dataQueryRepository.createOne.mockResolvedValue({
      id: 'query-1',
      name: 'list_orders',
      options: { operation: 'list_rows', table_id: 'table-1' },
    });

    const result = await service.CreateQuery('version-1', 'org-1', {
      name: 'list_orders',
      options: { operation: 'list_rows', table_id: 'table-1', list_rows: { limit: 100 } },
    });

    expect(dataSourcesRepository.getStaticDataSourceByKind).toHaveBeenCalledWith('org-1', 'tooljetdb');
    expect(dataQueryRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'list_orders',
        dataSourceId: 'ds-1',
        appVersionId: 'version-1',
        options: { operation: 'list_rows', table_id: 'table-1', list_rows: { limit: 100 } },
      })
    );
    expect(result.name).toBe('list_orders');
  });
});
