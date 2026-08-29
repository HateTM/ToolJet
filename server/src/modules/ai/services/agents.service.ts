import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAgentsService } from '../interfaces/IAgentsService';
import { TooljetDbTableOperationsService } from '@modules/tooljet-db/services/tooljet-db-table-operations.service';
import { PageService } from '@modules/apps/services/page.service';
import { ComponentsService } from '@modules/apps/services/component.service';
import { EventsService } from '@modules/apps/services/event.service';
import { DataQueryRepository } from '@modules/data-queries/repository';
import { DataSourcesRepository } from '@modules/data-sources/repository';
import { VersionRepository } from '@modules/versions/repository';
import { Target } from '@entities/event_handler.entity';
import { StepType } from '@entities/step.entity';

// Maps a ToolJet DB column data type to the Form field type the widget's JSON schema
// understands. Every TJDB type from service.ts gets a deliberate choice; the fallback
// is a text input, never an accidental implicit fall-through.
const TJDB_TO_FORM_FIELD_TYPE: Record<string, string> = {
  'character varying': 'textinput',
  integer: 'number',
  bigint: 'number',
  serial: 'number',
  'double precision': 'number',
  boolean: 'checkbox',
  'timestamp with time zone': 'datepicker',
  jsonb: 'textarea',
};

@Injectable()
export class AgentsService implements IAgentsService {
  constructor(
    private readonly tooljetDbTableOperationsService: TooljetDbTableOperationsService,
    private readonly pageService: PageService,
    private readonly componentsService: ComponentsService,
    private readonly eventsService: EventsService,
    private readonly dataQueryRepository: DataQueryRepository,
    private readonly dataSourcesRepository: DataSourcesRepository,
    private readonly versionRepository: VersionRepository
  ) {}

  /**
   * `tables` is the single-table creation payload for TooljetDbTableOperationsService's
   * 'create_table' action: { table_name, columns: [{ column_name, data_type,
   * constraints_type: { is_primary_key, is_not_null, is_unique }, column_default? }],
   * foreign_keys? }. One CreateTable Step creates exactly one table (CONTEXT.md: "Each
   * Step produces exactly one Artifact"), so this always returns a single { id, table_name }
   * result — errors (missing primary key, duplicate table name, etc.) propagate as-is so the
   * Step-execution retry loop can catch and act on them.
   */
  async CreateTable(organizationId: string, tables): Promise<any> {
    return this.tooljetDbTableOperationsService.perform(organizationId, 'create_table', tables);
  }

  /**
   * `props`'s shape depends on `type` (v1 allow-list complete as of this ticket — ADR-0002):
   *  - 'Page':      { name }
   *  - 'Table':      { pageId, title, queryName } — data bound to {{queries.<queryName>.data}}
   *  - 'Button':     { pageId, text }
   *  - 'Text':       { pageId, text }
   *  - 'TextInput':  { pageId, label, placeholder? }
   *  - 'Container':  { pageId, title } — an empty container; nesting children into it is not
   *    supported yet (out of this ticket's scope, no acceptance criterion asks for it)
   *  - 'Form':       { pageId, title, tableId, columns } — see createFormComponent's doc
   *    comment and ADR-0007. `pageId` is an earlier CreateComponent(Page) step's Artifact id,
   *    `queryName`/`tableId` reference earlier CreateQuery/CreateTable steps' real ids/names.
   *  - 'Chart':      { pageId, title, queryName?, chartType? } — data bound to
   *    {{queries.<queryName>.data}} when a queryName is given, else the widget's default
   *    empty data; chartType is 'line' | 'bar' | 'pie' (default 'line')
   *  - 'Image':      { pageId, source, alternativeText? }
   *  - 'Checkbox':   { pageId, label, defaultChecked? }
   *  - 'Dropdown':   { pageId, label, options: string[], placeholder? } — options become the
   *    widget's static option list in display order
   *  - 'Modal':      { pageId, title, triggerButtonLabel? } — an empty modal with its default
   *    trigger button; nesting children inside it is not supported (same as Container)
   * Callers should treat an unrecognized `type` as retryable (unlike an unsupported Step
   * type, which can never succeed): the model chooses `type` per attempt, so a later retry
   * may pick a supported one.
   */
  async CreateComponent(appVersionId: string, organizationId: string, type: string, props: any): Promise<any> {
    if (type === 'Page') {
      return this.createPageComponent(appVersionId, organizationId, props);
    }
    if (type === 'Table') {
      return this.createTableComponent(appVersionId, props);
    }
    if (type === 'Button') {
      return this.createButtonComponent(appVersionId, props);
    }
    if (type === 'Text') {
      return this.createTextComponent(appVersionId, props);
    }
    if (type === 'TextInput') {
      return this.createTextInputComponent(appVersionId, props);
    }
    if (type === 'Container') {
      return this.createContainerComponent(appVersionId, props);
    }
    if (type === 'Form') {
      return this.createFormComponent(appVersionId, organizationId, props);
    }
    if (type === 'Chart') {
      return this.createChartComponent(appVersionId, props);
    }
    if (type === 'Image') {
      return this.createImageComponent(appVersionId, props);
    }
    if (type === 'Checkbox') {
      return this.createCheckboxComponent(appVersionId, props);
    }
    if (type === 'Dropdown') {
      return this.createDropdownComponent(appVersionId, props);
    }
    if (type === 'Modal') {
      return this.createModalComponent(appVersionId, props);
    }
    throw new Error(`Unsupported component type "${type}"`);
  }

  private async createPageComponent(appVersionId: string, organizationId: string, props: any) {
    const name = (props?.name || 'Page').slice(0, 32);
    const handle =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-+|-+$)/g, '') || 'page';

    return this.pageService.createPage({ id: uuidv4(), name, handle, index: 0 } as any, appVersionId, organizationId);
  }

  /**
   * Shared plumbing for every widget-on-a-page builder below: generates the component id,
   * assembles the componentDiff ComponentsService.create expects, creates it, and returns a
   * consistent { id, pageId, type } result shape each caller can extend with type-specific
   * fields. Each builder supplies only what actually differs — its properties/styles and its
   * canvas footprint (matching the real widget's own `defaultSize` from
   * frontend/src/AppBuilder/WidgetManager/widgets/*.js, not invented).
   */
  private async createWidgetComponent(
    appVersionId: string,
    pageId: string,
    type: string,
    name: string,
    properties: Record<string, any>,
    styles: Record<string, any>,
    layout: { width: number; height: number }
  ): Promise<{ id: string; pageId: string; type: string }> {
    const componentId = uuidv4();
    const componentDiff = {
      [componentId]: {
        name,
        type,
        parent: null,
        properties,
        styles,
        layouts: {
          desktop: { top: 0, left: 0, width: layout.width, height: layout.height },
        },
      },
    };

    // ComponentsService.create's own return value carries no useful data (it resolves to
    // {} — see component.service.ts's dbTransactionForAppVersionAssociationsUpdate wrapper);
    // componentId is already known since it's generated here, so nothing is lost.
    await this.componentsService.create(componentDiff, pageId, appVersionId);
    return { id: componentId, pageId, type };
  }

  /**
   * Deliberately minimal Table properties/styles — enough to actually render and show
   * bound data (dataSourceSelector + data + autogenerateColumns), not a full mirror of
   * table.js's much larger default set, which isn't reachable from server-side code.
   * `layouts.desktop` uses that widget's own `defaultSize` ({ width: 25, height: 460 }).
   */
  private async createTableComponent(appVersionId: string, props: any) {
    const { pageId, title, queryName } = props ?? {};
    const name = title || 'Table';
    const created = await this.createWidgetComponent(
      appVersionId,
      pageId,
      'Table',
      name,
      {
        title: { value: title || 'Table' },
        visible: { value: '{{true}}' },
        loadingState: { value: '{{false}}' },
        dataSourceSelector: { value: 'rawJson' },
        data: { value: `{{queries.${queryName}.data}}` },
        // generateNestedColumns nests under autogenerateColumns, not its own top-level
        // property — matches how the real Table widget stores it (table.js's definition).
        autogenerateColumns: { value: true, generateNestedColumns: false },
        rowsPerPage: { value: '{{10}}' },
        enablePagination: { value: '{{true}}' },
      },
      {
        columnTitleColor: { value: 'var(--cc-primary-text)' },
        containerBackgroundColor: { value: 'var(--cc-surface1-surface)' },
        textColor: { value: 'var(--cc-primary-text)' },
        borderColor: { value: 'var(--cc-weak-border)' },
        borderRadius: { value: '6' },
        tableType: { value: 'table-classic' },
      },
      { width: 25, height: 460 }
    );
    // `name` is the widget's component name (== its title) — surfaced here so the plan
    // context shows it to the model, letting an edit-mode Form reference this Table's
    // selectedRow by that name.
    return { ...created, name, queryName };
  }

  // defaultSize per button.js: { width: 4, height: 40 }.
  private async createButtonComponent(appVersionId: string, props: any) {
    const { pageId, text } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Button',
      text || 'Button',
      {
        text: { value: text || 'Button' },
        visibility: { value: '{{true}}' },
        disabledState: { value: '{{false}}' },
        loadingState: { value: '{{false}}' },
      },
      {},
      { width: 4, height: 40 }
    );
  }

  // defaultSize per text.js: { width: 6, height: 40 }.
  private async createTextComponent(appVersionId: string, props: any) {
    const { pageId, text } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Text',
      text ? text.slice(0, 32) : 'Text',
      {
        text: { value: text || '' },
        textFormat: { value: 'plainText' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 6, height: 40 }
    );
  }

  // defaultSize per textinput.js: { width: 10, height: 40 }.
  private async createTextInputComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'TextInput',
      label || 'TextInput',
      {
        label: { value: label || 'Label' },
        value: { value: '' },
        placeholder: { value: placeholder || '' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per container.js: { width: 15, height: 450 }. Standalone/empty — nesting
  // children into a Container isn't wired up yet (not asked for by this ticket).
  private async createContainerComponent(appVersionId: string, props: any) {
    const { pageId, title } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Container',
      title || 'Container',
      {
        showHeader: { value: '{{false}}' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 15, height: 450 }
    );
  }

  // defaultSize per chart.js: { width: 20, height: 400 }. `data` binds to the referenced
  // query's output when one is given (same binding the Table widget uses); without it the
  // widget renders with its own default empty data set. `type` is chart.js's own property
  // name for the rendering style ('line' | 'bar' | 'pie').
  private async createChartComponent(appVersionId: string, props: any) {
    const { pageId, title, queryName, chartType = 'line' } = props ?? {};
    const name = title || 'Chart';
    const created = await this.createWidgetComponent(
      appVersionId,
      pageId,
      'Chart',
      name,
      {
        title: { value: title || 'Chart' },
        ...(queryName ? { data: { value: `{{queries.${queryName}.data}}` } } : {}),
        type: { value: chartType },
        loadingState: { value: '{{false}}' },
      },
      {},
      { width: 20, height: 400 }
    );
    // Same surface as the Table builder: the plan context shows the query name, so a later
    // step (or edit-mode Form) can reference this chart's data source.
    return { ...created, name, queryName };
  }

  // defaultSize per image.js: { width: 10, height: 240 }.
  private async createImageComponent(appVersionId: string, props: any) {
    const { pageId, source, alternativeText } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Image',
      'Image',
      {
        imageFormat: { value: 'imageUrl' },
        source: { value: source || '' },
        alternativeText: { value: alternativeText || '' },
        loadingState: { value: '{{false}}' },
      },
      {},
      { width: 10, height: 240 }
    );
  }

  // defaultSize per checkbox.js: { width: 6, height: 30 }. `defaultValue` is the widget's
  // own property name for the initial checked state (its switch options are {{true}}/{{false}}).
  private async createCheckboxComponent(appVersionId: string, props: any) {
    const { pageId, label, defaultChecked = false } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Checkbox',
      label || 'Checkbox',
      {
        label: { value: label || 'Checkbox' },
        defaultValue: { value: defaultChecked ? '{{true}}' : '{{false}}' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 6, height: 30 }
    );
  }

  // defaultSize per dropdownV2.js: { width: 10, height: 40 }. `options` is the widget's
  // static (non-advanced) option list; each entry needs the per-field wrapper shape
  // ({ value: ... }) dropdownV2.js's own definition.defaults uses for disable/visible/default.
  private async createDropdownComponent(appVersionId: string, props: any) {
    const { pageId, label, options, placeholder } = props ?? {};
    const list = (options || []).map((option: string, index: number) => ({
      label: String(option),
      value: String(option),
      caption: null,
      disable: { value: false },
      visible: { value: true },
      default: { value: false },
    }));
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'DropdownV2',
      label || 'Dropdown',
      {
        label: { value: label || 'Select' },
        placeholder: { value: placeholder || 'Select an option' },
        advanced: { value: '{{false}}' },
        options: { value: list },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per modal.js: { width: 10, height: 34 }. Persisted as type 'Modal' (the
  // config's `component` field — componentTypeDefinitionMap is keyed by it, not by the
  // config's display name 'ModalLegacy'). Standalone/empty — like Container, placing
  // children inside isn't wired up; the default trigger button keeps it openable.
  private async createModalComponent(appVersionId: string, props: any) {
    const { pageId, title, triggerButtonLabel } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Modal',
      title || 'Modal',
      {
        title: { value: title || 'Modal' },
        useDefaultButton: { value: '{{true}}' },
        triggerButtonLabel: { value: triggerButtonLabel || 'Launch Modal' },
        closeOnClickingOutside: { value: '{{true}}' },
        hideOnEsc: { value: '{{true}}' },
        loadingState: { value: '{{false}}' },
      },
      {},
      { width: 10, height: 34 }
    );
  }

  /**
   * The Form's `name` doubles as a JS identifier: both the Form's own JSONSchema binding and
   * the insert query's value templates reference it via dot notation
   * (`{{components.<name>.data.<column>}}`), which ToolJet's runtime evaluates as a literal
   * JS expression — an invalid identifier (e.g. one starting with a digit, from a title like
   * "2024 Orders") would silently break every write for that Form. A random suffix also
   * guarantees uniqueness within a plan (nothing else prevents two Forms from sanitizing to
   * the same name — e.g. two "Contact Form" titles — which would otherwise make both bindings
   * ambiguous with no error at any layer).
   */
  private buildSafeFormName(title: string): string {
    const sanitized = (title || 'Form').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20) || 'Form';
    const base = /^[0-9]/.test(sanitized) ? `f_${sanitized}` : sanitized;
    const suffix = uuidv4().replace(/-/g, '').slice(0, 8);
    return `${base}_${suffix}`;
  }

  /**
   * Builds a working Form for `tableId` (ADR-0007). Fields are generated from the table's
   * real columns (skipping the primary key, which is auto-generated) via the Form widget's
   * own JSONSchema mechanism (`advanced: true` + a `{{ {...} }}` binding — form.js's real
   * default value uses exactly this shape), then a DataQuery is created against the same
   * table with each column's value bound to this Form's own field
   * (`{{components.<name>.data.<column>}}`), and an EventHandler wires the Form's `onSubmit`
   * to run that query.
   *
   * `mode` picks the write semantics:
   *  - 'create' (default): a `create_row` query; fields start blank.
   *  - 'edit': an `update_rows` query keyed on the referenced Table widget's `selectedRow`
   *    primary key, and fields pre-filled from `{{components.<tableName>.selectedRow.<column>}}`
   *    — the "selected record" context ADR-0007 once thought didn't exist, which the Table
   *    widget's `selectedRow` exposed variable actually already provides. Requires the plan
   *    to also have created a Table widget (named `tableName`) bound to the same table.
   */
  private async createFormComponent(appVersionId: string, organizationId: string, props: any) {
    const { pageId, title, tableId, columns, mode = 'create', tableName } = props ?? {};
    const formName = this.buildSafeFormName(title);
    const isEdit = mode === 'edit';
    const writableColumns = (columns || []).filter((column: any) => !column?.constraints_type?.is_primary_key);
    const primaryKeyColumn = (columns || []).find((column: any) => column?.constraints_type?.is_primary_key);

    if (isEdit && !tableName) {
      throw new Error('An edit-mode Form must reference the Table widget (tableName) whose selectedRow it binds to');
    }
    if (isEdit && !primaryKeyColumn) {
      throw new Error(
        `Cannot build an edit-mode Form for table "${tableId}": it has no primary key column to key the update on`
      );
    }

    const schemaProperties = writableColumns.reduce((acc: Record<string, any>, column: any) => {
      acc[column.column_name] = {
        type: TJDB_TO_FORM_FIELD_TYPE[column.data_type] ?? 'textinput',
        label: column.column_name,
        // Edit-mode fields pre-fill from the referenced Table's selected row (the input's
        // `value` binding — form.js reads it as the field's initial value); create-mode
        // fields stay blank (no `value`).
        ...(isEdit ? { value: `{{components.${tableName}.selectedRow.${column.column_name}}}` } : {}),
      };
      return acc;
    }, {});

    const jsonSchema = `{{ ${JSON.stringify({
      title: title || 'Form',
      properties: schemaProperties,
      submitButton: { value: 'Submit' },
    })} }}`;

    const created = await this.createWidgetComponent(
      appVersionId,
      pageId,
      'Form',
      formName,
      {
        loadingState: { value: '{{false}}' },
        advanced: { value: '{{true}}' },
        JSONSchema: { value: jsonSchema },
        showHeader: { value: '{{true}}' },
        showFooter: { value: '{{true}}' },
        validateOnSubmit: { value: '{{true}}' },
        resetOnSubmit: { value: '{{true}}' },
      },
      {
        backgroundColor: { value: 'var(--cc-surface1-surface)' },
        borderColor: { value: 'var(--cc-weak-border)' },
        borderRadius: { value: '6' },
      },
      { width: 15, height: 450 }
    );

    // Column bindings are identical across modes: each writable column's value template-binds
    // to this Form's own field data on submit. What differs is the operation and, for edit,
    // the row identity filter keyed on the referenced Table's selectedRow primary key.
    const columnBindings = writableColumns.reduce((acc: Record<string, any>, column: any, index: number) => {
      acc[`col_${index}`] = {
        column: column.column_name,
        value: `{{components.${formName}.data.${column.column_name}}}`,
      };
      return acc;
    }, {});

    const queryOptions = isEdit
      ? {
          operation: 'update_rows',
          table_id: tableId,
          update_rows: {
            where_filters: {
              filter_0: {
                column: primaryKeyColumn.column_name,
                operator: 'eq',
                value: `{{components.${tableName}.selectedRow.${primaryKeyColumn.column_name}}}`,
              },
            },
            columns: columnBindings,
          },
        }
      : {
          operation: 'create_row',
          table_id: tableId,
          create_row: columnBindings,
        };

    const dataQuery = await this.CreateQuery(appVersionId, organizationId, {
      name: `${isEdit ? 'update' : 'insert'}_${formName}`.toLowerCase(),
      options: queryOptions,
    });

    await this.eventsService.createEvent(
      {
        name: 'Submit form',
        event: {
          eventId: 'onSubmit',
          actionId: 'run-query',
          queryId: dataQuery.id,
          queryName: dataQuery.name,
          parameters: {},
        },
        eventType: Target.component,
        attachedTo: created.id,
        index: 0,
      } as any,
      appVersionId
    );

    return {
      ...created,
      tableId,
      queryId: dataQuery.id,
      queryName: dataQuery.name,
      ...(isEdit ? { mode: 'edit', tableName } : {}),
    };
  }

  /**
   * `props`: { name, options, dataSourceId? }.
   *
   * Without `dataSourceId` the query targets the built-in ToolJet DB, and `options` is
   * TooljetDbDataOperationsService's query-options shape (e.g. { operation:
   * 'list_rows'|'create_row'|'update_rows', table_id, ... }). That data source is
   * per-organization (created once at org setup), which is why it is looked up here rather
   * than passed in — no caller has ever had to know its id.
   *
   * With `dataSourceId` the query targets an already-connected external data source
   * (ADR-0019), and `options` is whatever that connector's own query shape is — for the SQL
   * family that is { mode: 'sql', query }. Nothing here interprets `options`; the plugin
   * does, at run time. The caller is responsible for the two matching, since a query whose
   * options don't fit its data source fails only when someone runs it.
   */
  async CreateQuery(appVersionId: string, organizationId: string, props: any): Promise<any> {
    const dataSourceId =
      props.dataSourceId ??
      (await this.dataSourcesRepository.getStaticDataSourceByKind(organizationId, 'tooljetdb')).id;

    return this.dataQueryRepository.createOne({
      name: props.name,
      options: props.options,
      dataSourceId,
      appVersionId,
    } as any);
  }

  /**
   * Reverts the real App/DB change a Step's Artifact made (ADR-0008) — the inverse of
   * CreateTable/CreateComponent/CreateQuery, dispatched on the same StepType the Artifact
   * was created under. Used by rewind: undo every step after the rewind target, back to
   * front, so a later step's dependency (a Form's table, a Table widget's query) is always
   * gone before the step that depends on it.
   */
  async undoArtifact(stepType: StepType, appVersionId: string, organizationId: string, content: any): Promise<void> {
    switch (stepType) {
      case 'CreateTable':
        return this.undoCreateTable(organizationId, content);
      case 'CreateQuery':
        return this.undoQuery(content.id);
      case 'CreateComponent':
        return this.undoCreateComponent(appVersionId, organizationId, content);
      default:
        throw new Error(`Cannot undo unsupported step type "${stepType}"`);
    }
  }

  private async undoCreateTable(organizationId: string, content: any): Promise<void> {
    await this.tooljetDbTableOperationsService.perform(organizationId, 'drop_table', {
      table_name: content.table_name,
    });
  }

  private async undoQuery(queryId: string): Promise<void> {
    await this.dataQueryRepository.deleteDataQueryEvents(queryId);
    await this.dataQueryRepository.deleteOne(queryId);
  }

  /**
   * A Page artifact (createPageComponent's return, the real Page entity) carries no
   * `pageId` of its own — every widget's content does (createWidgetComponent's shape) —
   * the same distinction executeComponentStep's pageId-hallucination check already relies
   * on. A Form artifact additionally carries `queryId` for the insert query ADR-0007
   * created alongside it, which has to go first: ComponentsService.delete already cascades
   * the Form's own submit EventHandler, but not a query that merely references the Form.
   */
  private async undoCreateComponent(appVersionId: string, organizationId: string, content: any): Promise<void> {
    if (content.pageId === undefined) {
      const editingVersion = await this.versionRepository.findVersion(appVersionId);
      await this.pageService.deletePage(content.id, appVersionId, editingVersion, false, organizationId);
      return;
    }
    if (content.queryId) {
      await this.undoQuery(content.queryId);
    }
    await this.componentsService.delete([content.id], appVersionId);
  }

  async docs(prompt: string, organizationId: string, previousMessages?: any[]): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async create_header_component(appTitle: string): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async classify(prompt: string, organizationId): Promise<any> {
    throw new Error('Method not implemented.');
  }
}
