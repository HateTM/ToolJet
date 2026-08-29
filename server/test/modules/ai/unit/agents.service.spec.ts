// server/test/modules/ai/unit/agents.service.spec.ts
import { AgentsService } from '@modules/ai/services/agents.service';

const buildMockTooljetDbTableOperationsService = () => ({
  perform: jest.fn(),
});

const buildMockPageService = () => ({
  createPage: jest.fn(),
  deletePage: jest.fn(),
});

const buildMockComponentsService = () => ({
  create: jest.fn(),
  delete: jest.fn(),
});

const buildMockEventsService = () => ({
  createEvent: jest.fn(),
});

const buildMockDataQueryRepository = () => ({
  createOne: jest.fn(),
  deleteDataQueryEvents: jest.fn(),
  deleteOne: jest.fn(),
});

const buildMockDataSourcesRepository = () => ({
  getStaticDataSourceByKind: jest.fn(),
});

const buildMockVersionRepository = () => ({
  findVersion: jest.fn(),
});

const buildAgentsService = (overrides: Partial<Record<string, any>> = {}) => {
  const tooljetDbTableOperationsService =
    overrides.tooljetDbTableOperationsService ?? buildMockTooljetDbTableOperationsService();
  const pageService = overrides.pageService ?? buildMockPageService();
  const componentsService = overrides.componentsService ?? buildMockComponentsService();
  const eventsService = overrides.eventsService ?? buildMockEventsService();
  const dataQueryRepository = overrides.dataQueryRepository ?? buildMockDataQueryRepository();
  const dataSourcesRepository = overrides.dataSourcesRepository ?? buildMockDataSourcesRepository();
  const versionRepository = overrides.versionRepository ?? buildMockVersionRepository();

  const service = new AgentsService(
    tooljetDbTableOperationsService as any,
    pageService as any,
    componentsService as any,
    eventsService as any,
    dataQueryRepository as any,
    dataSourcesRepository as any,
    versionRepository as any
  );

  return {
    service,
    tooljetDbTableOperationsService,
    pageService,
    componentsService,
    eventsService,
    dataQueryRepository,
    dataSourcesRepository,
    versionRepository,
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

    // 'Calendar' is outside the allow-list (and not one a widget builder handles) — same
    // role 'Chart' played before it joined the allow-list (ticket #13).
    await expect(service.CreateComponent('version-1', 'org-1', 'Calendar', {})).rejects.toThrow(
      /unsupported component type/i
    );
    expect(pageService.createPage).not.toHaveBeenCalled();
    expect(componentsService.create).not.toHaveBeenCalled();
  });

  it.each([
    ['Button', { pageId: 'page-1', text: 'Save' }, { width: 4, height: 40 }, 'Button'],
    ['Text', { pageId: 'page-1', text: 'Welcome' }, { width: 6, height: 40 }, 'Text'],
    ['TextInput', { pageId: 'page-1', label: 'Email' }, { width: 10, height: 40 }, 'TextInput'],
    ['Container', { pageId: 'page-1', title: 'Sidebar' }, { width: 15, height: 450 }, 'Container'],
    ['Chart', { pageId: 'page-1', title: 'Revenue' }, { width: 20, height: 400 }, 'Chart'],
    ['Image', { pageId: 'page-1', source: 'https://example.com/logo.png' }, { width: 10, height: 240 }, 'Image'],
    ['Checkbox', { pageId: 'page-1', label: 'Subscribe' }, { width: 6, height: 30 }, 'Checkbox'],
    ['Dropdown', { pageId: 'page-1', label: 'Status', options: ['Open', 'Closed'] }, { width: 10, height: 40 }, 'DropdownV2'],
    ['Modal', { pageId: 'page-1', title: 'Confirm' }, { width: 10, height: 34 }, 'Modal'],
  ])('creates a %s component on the given page with its real defaultSize', async (type, props, size, persistedType) => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    const result = await service.CreateComponent('version-1', 'org-1', type as string, props);

    const [componentDiff, pageId, appVersionId] = componentsService.create.mock.calls[0];
    expect(pageId).toBe('page-1');
    expect(appVersionId).toBe('version-1');
    const [definition] = Object.values(componentDiff) as any[];
    // The persisted type is the widget config's `component` field (what the canvas
    // resolves componentTypeDefinitionMap by) — same as the requested type for most
    // widgets, 'DropdownV2' for Dropdown.
    expect(definition.type).toBe(persistedType ?? type);
    expect(definition.layouts.desktop).toEqual({ top: 0, left: 0, ...size });
    expect(result).toMatchObject({ pageId: 'page-1', type: persistedType ?? type });
  });

  it('Text component stores the given text as its properties.text.value', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'Text', { pageId: 'page-1', text: 'Welcome' });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.properties.text.value).toBe('Welcome');
  });

  it('TextInput component stores label/placeholder', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'TextInput', {
      pageId: 'page-1',
      label: 'Email',
      placeholder: 'you@example.com',
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.properties.label.value).toBe('Email');
    expect(definition.properties.placeholder.value).toBe('you@example.com');
  });

  it('Chart component binds data to the referenced query and stores the chart type', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    const result = await service.CreateComponent('version-1', 'org-1', 'Chart', {
      pageId: 'page-1',
      title: 'Revenue',
      queryName: 'list_orders',
      chartType: 'bar',
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.type).toBe('Chart');
    expect(definition.properties.title.value).toBe('Revenue');
    expect(definition.properties.data.value).toBe('{{queries.list_orders.data}}');
    expect(definition.properties.type.value).toBe('bar');
    expect(result).toMatchObject({ type: 'Chart', queryName: 'list_orders' });
  });

  it('Chart component without a queryName leaves the widget default data in place (no binding)', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'Chart', { pageId: 'page-1', title: 'Empty chart' });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.properties.data).toBeUndefined();
    expect(definition.properties.type.value).toBe('line');
  });

  it('Image component stores the source URL and alt text', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'Image', {
      pageId: 'page-1',
      source: 'https://example.com/logo.png',
      alternativeText: 'Company logo',
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.properties.source.value).toBe('https://example.com/logo.png');
    expect(definition.properties.alternativeText.value).toBe('Company logo');
    expect(definition.properties.imageFormat.value).toBe('imageUrl');
  });

  it('Checkbox component stores the label and initial checked state', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'Checkbox', {
      pageId: 'page-1',
      label: 'Subscribe',
      defaultChecked: true,
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.properties.label.value).toBe('Subscribe');
    expect(definition.properties.defaultValue.value).toBe('{{true}}');
  });

  it('Dropdown component maps plain-string options onto the DropdownV2 option-list shape', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'Dropdown', {
      pageId: 'page-1',
      label: 'Status',
      options: ['Open', 'Closed'],
      placeholder: 'Pick one',
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.type).toBe('DropdownV2');
    expect(definition.properties.label.value).toBe('Status');
    expect(definition.properties.placeholder.value).toBe('Pick one');
    expect(definition.properties.advanced.value).toBe('{{false}}');
    expect(definition.properties.options.value).toEqual([
      expect.objectContaining({ label: 'Open', value: 'Open' }),
      expect.objectContaining({ label: 'Closed', value: 'Closed' }),
    ]);
  });

  it('Modal component persists as type Modal with a default trigger button', async () => {
    const { service, componentsService } = buildAgentsService();
    componentsService.create.mockResolvedValue({});

    await service.CreateComponent('version-1', 'org-1', 'Modal', {
      pageId: 'page-1',
      title: 'Confirm delete',
      triggerButtonLabel: 'Delete',
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.type).toBe('Modal');
    expect(definition.properties.title.value).toBe('Confirm delete');
    expect(definition.properties.useDefaultButton.value).toBe('{{true}}');
    expect(definition.properties.triggerButtonLabel.value).toBe('Delete');
  });
});

/** @group platform */
describe('AgentsService.CreateComponent — Form', () => {
  const orderColumns = [
    { column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } },
    { column_name: 'customer_name', data_type: 'character varying', constraints_type: { is_primary_key: false } },
    { column_name: 'quantity', data_type: 'integer', constraints_type: { is_primary_key: false } },
  ];
  const fullTypeColumns = [
    { column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } },
    { column_name: 'title', data_type: 'character varying', constraints_type: { is_primary_key: false } },
    { column_name: 'amount', data_type: 'integer', constraints_type: { is_primary_key: false } },
    { column_name: 'big_amount', data_type: 'bigint', constraints_type: { is_primary_key: false } },
    { column_name: 'ratio', data_type: 'double precision', constraints_type: { is_primary_key: false } },
    { column_name: 'active', data_type: 'boolean', constraints_type: { is_primary_key: false } },
    { column_name: 'created_at', data_type: 'timestamp with time zone', constraints_type: { is_primary_key: false } },
    { column_name: 'metadata', data_type: 'jsonb', constraints_type: { is_primary_key: false } },
  ];

  it('builds a create-record Form with JSONSchema fields for every non-primary-key column', async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_orders_form' });

    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Orders form',
      tableId: 'table-1',
      columns: orderColumns,
    });

    const [componentDiff, pageId, appVersionId] = componentsService.create.mock.calls[0];
    expect(pageId).toBe('page-1');
    expect(appVersionId).toBe('version-1');
    const [definition] = Object.values(componentDiff) as any[];
    expect(definition.type).toBe('Form');
    expect(definition.properties.advanced.value).toBe('{{true}}');

    const schemaMatch = definition.properties.JSONSchema.value.match(/\{\{ (.*) \}\}/);
    const schema = JSON.parse(schemaMatch[1]);
    // The primary key column is excluded — it's auto-generated, never user-entered.
    expect(Object.keys(schema.properties)).toEqual(['customer_name', 'quantity']);
    expect(schema.properties.customer_name.type).toBe('textinput');
    expect(schema.properties.quantity.type).toBe('number');
  });
  it('maps each TJDB column type to the matching Form field type', async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_full' });
    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Full types form',
      tableId: 'table-1',
      columns: fullTypeColumns,
    });
    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    const schemaMatch = definition.properties.JSONSchema.value.match(/\{\{ (.*) \}\}/);
    const schema = JSON.parse(schemaMatch[1]);
    expect(schema.properties.title.type).toBe('textinput');
    expect(schema.properties.amount.type).toBe('number');
    expect(schema.properties.big_amount.type).toBe('number');
    expect(schema.properties.ratio.type).toBe('number');
    expect(schema.properties.active.type).toBe('checkbox');
    expect(schema.properties.created_at.type).toBe('datepicker');
    expect(schema.properties.metadata.type).toBe('textarea');
  });
  it('falls back to textinput for an unknown TJDB column type', async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_full' });
    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Unknown type form',
      tableId: 'table-1',
      columns: [
        { column_name: 'id', data_type: 'serial', constraints_type: { is_primary_key: true } },
        { column_name: 'blob', data_type: 'unknown_type', constraints_type: { is_primary_key: false } },
      ],
    });
    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    const schemaMatch = definition.properties.JSONSchema.value.match(/\{\{ (.*) \}\}/);
    const schema = JSON.parse(schemaMatch[1]);
    expect(schema.properties.blob.type).toBe('textinput');
  });

  it('gives the Form a valid-JS-identifier name even when the title starts with a digit ({{components.<name>.data}} is evaluated as JS)', async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_form' });

    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: '2024 Orders',
      tableId: 'table-1',
      columns: orderColumns,
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [name, definition] = Object.entries(componentDiff)[0] as [string, any];
    expect(name).not.toBe(definition.name); // name is the componentDiff key (a uuid); definition.name is the Form's binding-safe identifier
    expect(definition.name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);

    const columnBindings = Object.values(
      (dataQueryRepository.createOne.mock.calls[0][0] as any).options.create_row
    ) as any[];
    for (const binding of columnBindings) {
      expect(binding.value).toContain(`components.${definition.name}.data.`);
    }
  });

  it('gives two Forms in the same plan different names even when their titles sanitize to the same string', async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_form' });

    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Contact Form',
      tableId: 'table-1',
      columns: orderColumns,
    });
    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Contact Form',
      tableId: 'table-1',
      columns: orderColumns,
    });

    const firstDefinition = Object.values(componentsService.create.mock.calls[0][0])[0] as any;
    const secondDefinition = Object.values(componentsService.create.mock.calls[1][0])[0] as any;
    expect(firstDefinition.name).not.toBe(secondDefinition.name);
  });

  it("creates an insert query whose column values are template-bound to the Form's own field data", async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_orders_form' });

    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Orders form',
      tableId: 'table-1',
      columns: orderColumns,
    });

    expect(dataSourcesRepository.getStaticDataSourceByKind).toHaveBeenCalledWith('org-1', 'tooljetdb');
    const [queryPayload] = dataQueryRepository.createOne.mock.calls[0];
    expect(queryPayload.dataSourceId).toBe('ds-1');
    expect(queryPayload.appVersionId).toBe('version-1');
    expect(queryPayload.options.operation).toBe('create_row');
    expect(queryPayload.options.table_id).toBe('table-1');
    const columnBindings = Object.values(queryPayload.options.create_row) as any[];
    expect(columnBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'customer_name', value: expect.stringContaining('.data.customer_name') }),
        expect.objectContaining({ column: 'quantity', value: expect.stringContaining('.data.quantity') }),
      ])
    );
    // The primary key is never written by the insert.
    expect(columnBindings.some((binding) => binding.column === 'id')).toBe(false);
  });

  it("wires the Form's onSubmit to run the insert query via EventsService.createEvent", async () => {
    const { service, componentsService, eventsService, dataQueryRepository, dataSourcesRepository } =
      buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'insert_orders_form' });

    const result = await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Orders form',
      tableId: 'table-1',
      columns: orderColumns,
    });

    expect(eventsService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'component',
        attachedTo: result.id,
        event: expect.objectContaining({ eventId: 'onSubmit', actionId: 'run-query', queryId: 'query-1' }),
      }),
      'version-1'
    );
    expect(result).toMatchObject({ tableId: 'table-1', queryId: 'query-1', queryName: 'insert_orders_form' });
  });

  it("builds an edit-mode Form whose fields are pre-filled from the referenced Table's selectedRow", async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'update_orders_form' });

    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Edit orders form',
      tableId: 'table-1',
      columns: orderColumns,
      mode: 'edit',
      tableName: 'orders_table',
    });

    const [componentDiff] = componentsService.create.mock.calls[0];
    const [definition] = Object.values(componentDiff) as any[];
    const schemaMatch = definition.properties.JSONSchema.value.match(/\{\{ (.*) \}\}/);
    const schema = JSON.parse(schemaMatch[1]);
    // Same column set as create-mode (non-PK only), but every field pre-fills from the
    // referenced Table's selectedRow instead of starting blank.
    expect(Object.keys(schema.properties)).toEqual(['customer_name', 'quantity']);
    expect(schema.properties.customer_name.value).toBe('{{components.orders_table.selectedRow.customer_name}}');
    expect(schema.properties.quantity.value).toBe('{{components.orders_table.selectedRow.quantity}}');
  });

  it("wires an edit-mode Form's update_rows query keyed on the selected row's primary key, with the PK excluded from the update body", async () => {
    const { service, componentsService, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'update_orders_form' });

    await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Edit orders form',
      tableId: 'table-1',
      columns: orderColumns,
      mode: 'edit',
      tableName: 'orders_table',
    });

    const [queryPayload] = dataQueryRepository.createOne.mock.calls[0];
    expect(queryPayload.options.operation).toBe('update_rows');
    expect(queryPayload.options.table_id).toBe('table-1');
    // The row identity filter keys on the selected row's primary key.
    expect(queryPayload.options.update_rows.where_filters.filter_0).toEqual({
      column: 'id',
      operator: 'eq',
      value: '{{components.orders_table.selectedRow.id}}',
    });
    // Updated values come from the Form's own fields; the primary key is never written.
    const columnBindings = Object.values(queryPayload.options.update_rows.columns) as any[];
    expect(columnBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'customer_name', value: expect.stringContaining('.data.customer_name') }),
        expect.objectContaining({ column: 'quantity', value: expect.stringContaining('.data.quantity') }),
      ])
    );
    expect(columnBindings.some((binding) => binding.column === 'id')).toBe(false);
  });

  it('throws when an edit-mode Form is missing its referenced tableName', async () => {
    const { service, dataQueryRepository } = buildAgentsService();

    await expect(
      service.CreateComponent('version-1', 'org-1', 'Form', {
        pageId: 'page-1',
        title: 'Edit orders form',
        tableId: 'table-1',
        columns: orderColumns,
        mode: 'edit',
      })
    ).rejects.toThrow(/tableName/);
    expect(dataQueryRepository.createOne).not.toHaveBeenCalled();
  });

  it("wires an edit-mode Form's onSubmit to run the update query", async () => {
    const { service, componentsService, eventsService, dataQueryRepository, dataSourcesRepository } =
      buildAgentsService();
    componentsService.create.mockResolvedValue({});
    dataSourcesRepository.getStaticDataSourceByKind.mockResolvedValue({ id: 'ds-1' });
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-1', name: 'update_orders_form' });

    const result = await service.CreateComponent('version-1', 'org-1', 'Form', {
      pageId: 'page-1',
      title: 'Edit orders form',
      tableId: 'table-1',
      columns: orderColumns,
      mode: 'edit',
      tableName: 'orders_table',
    });

    expect(eventsService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'component',
        attachedTo: result.id,
        event: expect.objectContaining({ eventId: 'onSubmit', actionId: 'run-query', queryId: 'query-1' }),
      }),
      'version-1'
    );
    expect(result).toMatchObject({
      tableId: 'table-1',
      queryId: 'query-1',
      queryName: 'update_orders_form',
      mode: 'edit',
      tableName: 'orders_table',
    });
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

  it('creates the query against an explicitly given data source, without looking up ToolJet DB', async () => {
    const { service, dataQueryRepository, dataSourcesRepository } = buildAgentsService();
    dataQueryRepository.createOne.mockResolvedValue({ id: 'query-2', name: 'list_customers' });

    const result = await service.CreateQuery('version-1', 'org-1', {
      name: 'list_customers',
      dataSourceId: 'ds-postgres',
      options: { mode: 'sql', query: 'SELECT * FROM customers LIMIT 100' },
    });

    expect(dataSourcesRepository.getStaticDataSourceByKind).not.toHaveBeenCalled();
    expect(dataQueryRepository.createOne).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'list_customers',
        dataSourceId: 'ds-postgres',
        appVersionId: 'version-1',
        options: { mode: 'sql', query: 'SELECT * FROM customers LIMIT 100' },
      })
    );
    expect(result.name).toBe('list_customers');
  });
});

/** @group platform */
describe('AgentsService.undoArtifact', () => {
  it('drops the table for a CreateTable artifact, by table_name', async () => {
    const { service, tooljetDbTableOperationsService } = buildAgentsService();

    await service.undoArtifact('CreateTable', 'version-1', 'org-1', { id: 'tjdb-1', table_name: 'orders' });

    expect(tooljetDbTableOperationsService.perform).toHaveBeenCalledWith('org-1', 'drop_table', {
      table_name: 'orders',
    });
  });

  it('deletes a CreateQuery artifact, clearing its events first', async () => {
    const { service, dataQueryRepository } = buildAgentsService();

    await service.undoArtifact('CreateQuery', 'version-1', 'org-1', { id: 'query-1', name: 'list_orders' });

    expect(dataQueryRepository.deleteDataQueryEvents).toHaveBeenCalledWith('query-1');
    expect(dataQueryRepository.deleteOne).toHaveBeenCalledWith('query-1');
  });

  it('deletes a Page artifact via PageService.deletePage, resolving the editing AppVersion first', async () => {
    const { service, pageService, versionRepository } = buildAgentsService();
    versionRepository.findVersion.mockResolvedValue({ id: 'version-1', homePageId: 'other-page' });

    await service.undoArtifact('CreateComponent', 'version-1', 'org-1', { id: 'page-1', name: 'Orders' });

    expect(versionRepository.findVersion).toHaveBeenCalledWith('version-1');
    expect(pageService.deletePage).toHaveBeenCalledWith(
      'page-1',
      'version-1',
      { id: 'version-1', homePageId: 'other-page' },
      false,
      'org-1'
    );
  });

  it('deletes a plain widget artifact (has a pageId) via ComponentsService.delete', async () => {
    const { service, componentsService } = buildAgentsService();

    await service.undoArtifact('CreateComponent', 'version-1', 'org-1', {
      id: 'component-1',
      pageId: 'page-1',
      type: 'Button',
    });

    expect(componentsService.delete).toHaveBeenCalledWith(['component-1'], 'version-1');
  });

  it("deletes a Form artifact's insert query before the Form component itself", async () => {
    const { service, dataQueryRepository, componentsService } = buildAgentsService();
    const callOrder: string[] = [];
    dataQueryRepository.deleteOne.mockImplementation(async () => {
      callOrder.push('deleteQuery');
    });
    componentsService.delete.mockImplementation(async () => {
      callOrder.push('deleteComponent');
    });

    await service.undoArtifact('CreateComponent', 'version-1', 'org-1', {
      id: 'form-1',
      pageId: 'page-1',
      type: 'Form',
      tableId: 'table-1',
      queryId: 'query-1',
      queryName: 'insert_orders_form',
    });

    expect(dataQueryRepository.deleteDataQueryEvents).toHaveBeenCalledWith('query-1');
    expect(dataQueryRepository.deleteOne).toHaveBeenCalledWith('query-1');
    expect(componentsService.delete).toHaveBeenCalledWith(['form-1'], 'version-1');
    expect(callOrder).toEqual(['deleteQuery', 'deleteComponent']);
  });

  it('throws for a step type it has no undo handler for', async () => {
    const { service } = buildAgentsService();

    await expect(service.undoArtifact('SomeFutureStepType' as any, 'version-1', 'org-1', {})).rejects.toThrow(
      'Cannot undo unsupported step type "SomeFutureStepType"'
    );
  });
});
