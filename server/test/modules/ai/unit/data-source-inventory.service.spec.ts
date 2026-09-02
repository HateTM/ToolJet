// server/test/modules/ai/unit/data-source-inventory.service.spec.ts
import { DataSourceInventoryService, renderConnectedDataSources } from '@modules/ai/services/data-source-inventory.service';

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

  it('offers SQL-family and restapi sources, ignoring every other kind the org has connected', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      { id: 'ds-rest', name: 'Stripe', kind: 'restapi' },
      { id: 'ds-tjdb', name: 'ToolJet DB', kind: 'tooljetdb' },
      { id: 'ds-mongo', name: 'Events', kind: 'mongodb' },
      { id: 'ds-pg', name: 'Warehouse', kind: 'postgresql' },
    ]);
    dataQueriesUtilService.listTables.mockResolvedValue({ status: 'ok', data: [{ table_name: 'orders' }] });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources.map((source) => source.id).sort()).toEqual(['ds-pg', 'ds-rest']);
    // Only the SQL source's schema is read — a restapi source has no schema to introspect.
    expect(dataQueriesUtilService.listTables).toHaveBeenCalledTimes(1);
  });

  // Increment 5: a restapi source has no schema to read at all, so — unlike a SQL source —
  // reporting zero tables must not drop it from the inventory.
  it('keeps a restapi source even though it reports no tables, unlike an empty SQL source', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-rest', name: 'Petstore', kind: 'restapi' }]);

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources).toEqual([{ id: 'ds-rest', name: 'Petstore', kind: 'restapi', tables: [] }]);
    expect(dataQueriesUtilService.listTables).not.toHaveBeenCalled();
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

  // Increment 5 follow-up (ADR-0045): a plugin source is queryable when its manifest exposes
  // a real operation dropdown — derived from the manifest, never a hardcoded kind list.
  it('offers a plugin source whose manifest has a real operation dropdown, carrying the operations list', async () => {
    const { service, dataSourcesRepository } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      {
        id: 'ds-slack',
        name: 'Team Slack',
        kind: 'slack',
        plugin: {
          operationsFile: {
            data: {
              properties: {
                operation: {
                  list: [
                    { name: 'List members', value: 'list_users' },
                    { name: 'Send message', value: 'send_message' },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(sources).toEqual([
      {
        id: 'ds-slack',
        name: 'Team Slack',
        kind: 'slack',
        tables: [],
        operations: [
          { name: 'List members', value: 'list_users' },
          { name: 'Send message', value: 'send_message' },
        ],
      },
    ]);
  });

  // Notion's real operations.json has no flat `operation` dropdown (a resource/database/page
  // tree instead) — there is nothing to ground a tool call in, so it's silently excluded,
  // the same tolerant drop an unreadable SQL schema already gets.
  it('excludes a plugin source whose manifest has no flat operation dropdown to ground a tool call in', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      {
        id: 'ds-notion',
        name: 'Notion',
        kind: 'notion',
        plugin: { operationsFile: { data: { properties: { resource: {}, database: {}, page: {} } } } },
      },
    ]);

    await expect(service.listQueryableSources(USER, PERMISSIONS)).resolves.toEqual([]);
    expect(dataQueriesUtilService.listTables).not.toHaveBeenCalled();
  });

  // The pre-loop filter admits any source with a `plugin` relation, which includes SQL-family
  // marketplace plugins too — the loop's kind-ordering (SQL check before the operation-dropdown
  // check) is what keeps a SQL source on the schema-introspection path instead of being
  // (mis)treated as a plugin source.
  it('still reads a SQL source through listTables even when it also carries a plugin relation', async () => {
    const { service, dataSourcesRepository, dataQueriesUtilService } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([
      {
        id: 'ds-pg',
        name: 'Warehouse',
        kind: 'postgresql',
        plugin: { operationsFile: { data: { properties: { operation: { list: [{ value: 'noop' }] } } } } },
      },
    ]);
    dataQueriesUtilService.listTables.mockResolvedValue({ status: 'ok', data: [{ table_name: 'orders' }] });

    const sources = await service.listQueryableSources(USER, PERMISSIONS);

    expect(dataQueriesUtilService.listTables).toHaveBeenCalledTimes(1);
    expect(sources).toEqual([{ id: 'ds-pg', name: 'Warehouse', kind: 'postgresql', tables: ['orders'] }]);
  });

  it('excludes a plugin source with no plugin/operationsFile data at all, without throwing', async () => {
    const { service, dataSourcesRepository } = buildInventoryService();
    dataSourcesRepository.allGlobalDS.mockResolvedValue([{ id: 'ds-mystery', name: 'Mystery', kind: 'mystery' }]);

    await expect(service.listQueryableSources(USER, PERMISSIONS)).resolves.toEqual([]);
  });
});

describe('renderConnectedDataSources (increment 5)', () => {
  it('renders a SQL source with its table list, and a restapi source without one', () => {
    const rendered = renderConnectedDataSources([
      { id: 'ds-pg', name: 'Warehouse', kind: 'postgresql', tables: ['orders', 'customers'] },
      { id: 'ds-rest', name: 'Petstore', kind: 'restapi', tables: [] },
    ]);

    expect(rendered).toContain('Warehouse (postgresql), id ds-pg — tables: orders, customers');
    expect(rendered).toContain('Petstore (restapi), id ds-rest — a REST API');
    expect(rendered).not.toContain('Petstore (restapi), id ds-rest — tables:');
  });

  it('renders nothing when there are no connected sources', () => {
    expect(renderConnectedDataSources([])).toBe('');
  });

  it('renders a plugin source by its operations, not a table list or "give a request path"', () => {
    const rendered = renderConnectedDataSources([
      {
        id: 'ds-slack',
        name: 'Team Slack',
        kind: 'slack',
        tables: [],
        operations: [
          { name: 'List members', value: 'list_users' },
          { name: 'Send message', value: 'send_message' },
        ],
      },
    ]);

    expect(rendered).toContain('Team Slack (slack), id ds-slack — a plugin; operations: list_users, send_message');
  });
});
