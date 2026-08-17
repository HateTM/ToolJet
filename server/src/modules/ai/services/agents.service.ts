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

// ToolJet DB column data types that map to a numeric form field; everything else (text,
// boolean, timestamp, jsonb) falls back to a plain text input — safe/functional, if not
// the most precise widget for every column type.
const NUMERIC_TJDB_TYPES = ['integer', 'bigint', 'serial', 'double precision'];

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
    const created = await this.createWidgetComponent(
      appVersionId,
      pageId,
      'Table',
      title || 'Table',
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
    return { ...created, queryName };
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
   * Builds a working create-record Form for `tableId` (ADR-0007): fields are generated from
   * the table's real columns (skipping the primary key, which is auto-generated) via the
   * Form widget's own JSONSchema mechanism (`advanced: true` + a `{{ {...} }}` binding —
   * form.js's real default value uses exactly this shape), then a `create_row` DataQuery is
   * created against the same table with each column's value bound to this Form's own field
   * (`{{components.<name>.data.<column>}}`), and an EventHandler wires the Form's `onSubmit`
   * to run that query. v1 is create-mode only (see ADR-0007 for why edit is deferred).
   */
  private async createFormComponent(appVersionId: string, organizationId: string, props: any) {
    const { pageId, title, tableId, columns } = props ?? {};
    const formName = this.buildSafeFormName(title);
    const writableColumns = (columns || []).filter((column: any) => !column?.constraints_type?.is_primary_key);

    const schemaProperties = writableColumns.reduce((acc: Record<string, any>, column: any) => {
      acc[column.column_name] = {
        type: NUMERIC_TJDB_TYPES.includes(column.data_type) ? 'number' : 'textinput',
        label: column.column_name,
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

    const insertQuery = await this.CreateQuery(appVersionId, organizationId, {
      name: `insert_${formName}`.toLowerCase(),
      options: {
        operation: 'create_row',
        table_id: tableId,
        create_row: writableColumns.reduce((acc: Record<string, any>, column: any, index: number) => {
          acc[`col_${index}`] = {
            column: column.column_name,
            value: `{{components.${formName}.data.${column.column_name}}}`,
          };
          return acc;
        }, {}),
      },
    });

    await this.eventsService.createEvent(
      {
        name: 'Submit form',
        event: {
          eventId: 'onSubmit',
          actionId: 'run-query',
          queryId: insertQuery.id,
          queryName: insertQuery.name,
          parameters: {},
        },
        eventType: Target.component,
        attachedTo: created.id,
        index: 0,
      } as any,
      appVersionId
    );

    return { ...created, tableId, queryId: insertQuery.id, queryName: insertQuery.name };
  }

  /**
   * `props`: { name, options } — options is TooljetDbDataOperationsService's query-options
   * shape (e.g. { operation: 'list_rows'|'create_row'|'update_rows', table_id, ... }). The
   * built-in ToolJet DB data source is per-organization (created once at org setup), looked
   * up here rather than passed in.
   */
  async CreateQuery(appVersionId: string, organizationId: string, props: any): Promise<any> {
    const dataSource = await this.dataSourcesRepository.getStaticDataSourceByKind(organizationId, 'tooljetdb');

    return this.dataQueryRepository.createOne({
      name: props.name,
      options: props.options,
      dataSourceId: dataSource.id,
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

  async copilot(prompt: string, context: string, language: string, organizationId): Promise<any> {
    throw new Error('Method not implemented.');
  }
}
