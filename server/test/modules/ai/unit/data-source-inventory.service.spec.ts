// server/test/modules/ai/unit/data-source-inventory.service.spec.ts
import { DataSourceInventoryService } from '@modules/ai/services/data-source-inventory.service';

const USER = { id: 'user-1', organizationId: 'org-1' } as any;
const PERMISSIONS = { isAdmin: true } as any;

const buildMockDataSourcesRepository = () => ({
  allGlobalDS: jest.fn().mockResolvedValue([]),
});

const buildMockDataQueriesUtilService = () => ({
  listTables: jest.fn(),
});

const buildInventoryService = (overrides: Partial<Record<string, any>> = {}) => {
  const dataSourcesRepository = overrides.dataSourcesRepository ?? buildMockDataSourcesRepository();
  const dataQueriesUtilService = overrides.dataQueriesUtilService ?? buildMockDataQueriesUtilService();

  const service = new DataSourceInventoryService(dataSourcesRepository as any, dataQueriesUtilService as any);

  return { service, dataSourcesRepository, dataQueriesUtilService };
};

/** @group platform */
describe('DataSourceInventoryService.listQueryableSources', () => {
  it("lists the org's connected SQL data sources with the table names read off each connector", async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-1', name: 'Warehouse', kind: 'postgresql' }]);
    dataQueriesUtilService.listTables.mockResolvedValue({
      status: 'ok',
      data: [
        { table_name: 'orders', table_schema: 'public' },
        { table_name: 'customers', table_schema: 'public' },
      ],
    });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources).toEqual([
      { id: 'ds-1', name: 'Warehouse', kind: 'postgresql', tables: ['public.orders', 'public.customers'] },
    ]);
  });

  // The list goes verbatim into a prompt and then into queries built against real credentials,
  // so it has to be the same permission-filtered listing the data source panel uses.
  it("reads the sources through the permission-filtered listing, passing the caller's permissions", async () => {
    const { service, dataSourcesRepository } = buildInventoryService();

    await service.listQueryableSources(USER, PERMISSIONS);

    expect(dataSourcesRepository.allGlobalDS).toHaveBeenCalledWith(PERMISSIONS, 'org-1', expect.anything());
  });

  it('offers only SQL-family sources, ignoring the other kinds the org has connected', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      { id: 'ds-rest', name: 'Stripe', kind: 'restapi' },
      { id: 'ds-tjdb', name: 'ToolJet DB', kind: 'tooljetdb' },
      { id: 'ds-mongo', name: 'Events', kind: 'mongodb' },
      { id: 'ds-pg', name: 'Warehouse', kind: 'postgresql' },
    ]);
    dataQueriesUtilService.listTables.mockResolvedValue({ status: 'ok', data: [{ table_name: 'orders' }] });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources.map((source) => source.id)).toEqual(['ds-pg']);
    expect(dataQueriesUtilService.listTables).toHaveBeenCalledTimes(1);
  });

  it("never offers a sample data source — it is ToolJet's demo data, not something the user connected", async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      { id: 'ds-sample', name: 'Sample data source', kind: 'postgresql', type: 'sample' },
    ]);
    dataQueriesUtilService.listTables.mockResolvedValue({ status: 'ok', data: [{ table_name: 'orders' }] });

    await expect(service.listQueryableSources(USER, PERMISSIONS)).resolves.toEqual([]);
    expect(dataQueriesUtilService.listTables).not.toHaveBeenCalled();
  });

  it('never touches a connector when the org has no SQL data sources connected', async () => {
    const { service, dataQueriesUtilService } = buildInventoryService();

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources).toEqual([]);
    expect(dataQueriesUtilService.listTables).not.toHaveBeenCalled();
  });

  // Oracle's listTables returns option-picker rows ({ value, label }) rather than the
  // { table_name } information_schema rows Postgres/MySQL/MSSQL return.
  it('reads a connector that reports its tables as { value, label } rows', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-2', name: 'Ledger', kind: 'oracledb' }]);
    dataQueriesUtilService.listTables.mockResolvedValue({
      status: 'ok',
      data: [
        { value: 'INVOICES', label: 'INVOICES' },
        { value: 'PAYMENTS', label: 'PAYMENTS' },
      ],
    });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources[0].tables).toEqual(['INVOICES', 'PAYMENTS']);
  });

  it('reads a connector that wraps its rows in a paginated { rows } envelope', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-3', name: 'Sales', kind: 'mysql' }]);
    dataQueriesUtilService.listTables.mockResolvedValue({
      status: 'ok',
      data: { rows: [{ table_name: 'leads' }], totalCount: 1 },
    });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources[0].tables).toEqual(['leads']);
  });

  // A bare `orders` is ambiguous the moment two schemas both hold one, and the model would
  // write a SELECT the source rejects — the invisible failure reading the real schema exists
  // to prevent.
  it('qualifies a table with its schema whenever the connector reports one', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-1', name: 'Warehouse', kind: 'postgresql' }]);
    dataQueriesUtilService.listTables.mockResolvedValue({
      status: 'ok',
      data: [
        { table_name: 'orders', table_schema: 'sales' },
        { table_name: 'orders', table_schema: 'archive' },
        { table_name: 'unqualified' },
      ],
    });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources[0].tables).toEqual(['sales.orders', 'archive.orders', 'unqualified']);
  });

  // Postgres' listTables defaults to the `public` schema, so a source whose tables live
  // elsewhere would report none and be dropped as empty.
  it('asks Postgres for every schema, and leaves the other connectors on their own default', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      { id: 'ds-pg', name: 'A Warehouse', kind: 'postgresql' },
      { id: 'ds-oracle', name: 'B Ledger', kind: 'oracledb' },
    ]);
    dataQueriesUtilService.listTables.mockResolvedValue({ status: 'ok', data: [{ table_name: 'orders' }] });

    await service.listQueryableSources(USER, PERMISSIONS);

    expect(dataQueriesUtilService.listTables).toHaveBeenNthCalledWith(
      1,
      USER,
      expect.anything(),
      undefined,
      undefined,
      {
        schema: 'all',
      }
    );
    expect(dataQueriesUtilService.listTables).toHaveBeenNthCalledWith(
      2,
      USER,
      expect.anything(),
      undefined,
      undefined,
      undefined
    );
  });

  it('drops a source whose schema could not be read, and keeps the ones that could', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      { id: 'ds-broken', name: 'A Unreachable', kind: 'mariadb' },
      { id: 'ds-ok', name: 'B Warehouse', kind: 'postgresql' },
    ]);
    dataQueriesUtilService.listTables
      .mockRejectedValueOnce(new Error('service.listTables is not a function'))
      .mockResolvedValueOnce({ status: 'ok', data: [{ table_name: 'orders' }] });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources.map((source) => source.id)).toEqual(['ds-ok']);
  });

  it('drops a source that reports no tables at all, since there is nothing to write a query against', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-empty', name: 'Fresh', kind: 'postgresql' }]);
    dataQueriesUtilService.listTables.mockResolvedValue({ status: 'ok', data: [] });

    await expect(service.listQueryableSources(USER, PERMISSIONS)).resolves.toEqual([]);
  });

  it('caps how many tables one source contributes, so a large schema cannot crowd out the prompt', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-big', name: 'Big', kind: 'postgresql' }]);
    dataQueriesUtilService.listTables.mockResolvedValue({
      status: 'ok',
      data: Array.from({ length: 200 }, (_, index) => ({ table_name: `table_${index}` })),
    });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources[0].tables.length).toBeLessThan(200);
    expect(sources[0].tables[0]).toBe('table_0');
  });

  it('caps on the sources it could actually read, so unreachable ones cannot hide a readable one', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    // Twelve sources, only the last readable — a cap applied before the filter returns nothing.
    dataSourcesRepository.allGlobalDS.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => ({
        id: `ds-${index}`,
        name: `Source ${String(index).padStart(2, '0')}`,
        kind: 'postgresql',
      }))
    );
    dataQueriesUtilService.listTables.mockImplementation(async (_user: any, dataSource: any) =>
      dataSource.id === 'ds-11' ? { status: 'ok', data: [{ table_name: 'orders' }] } : { status: 'ok', data: [] }
    );

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources.map((source) => source.id)).toEqual(['ds-11']);
  });

  // The inventory is an enrichment, not a precondition: every plan that could be built before
  // this ticket targets ToolJet DB, and that plan must not start failing because the lookup
  // this ticket added had a bad day.
  it('reports nothing connected rather than failing the build when the lookup itself errors', async () => {
    const { service, dataSourcesRepository } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockRejectedValue(new Error('db is down'));

    await expect(service.listQueryableSources(USER, PERMISSIONS)).resolves.toEqual([]);
  });
});
