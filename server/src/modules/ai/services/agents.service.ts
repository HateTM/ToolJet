import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAgentsService, SeedTableReport } from '../interfaces/IAgentsService';
import { TooljetDbTableOperationsService } from '@modules/tooljet-db/services/tooljet-db-table-operations.service';
import { TooljetDbBulkUploadService } from '@modules/tooljet-db/services/tooljet-db-bulk-upload.service';
import { PageService } from '@modules/apps/services/page.service';
import { ComponentsService } from '@modules/apps/services/component.service';
import { EventsService } from '@modules/apps/services/event.service';
import { DataQueryRepository } from '@modules/data-queries/repository';
import { DataSourcesRepository } from '@modules/data-sources/repository';
import { DataSourcesUtilService } from '@modules/data-sources/util.service';
import { PluginsServiceSelector } from '@modules/data-sources/services/plugin-selector.service';
import { AppEnvironmentUtilService } from '@modules/app-environments/util.service';
import { VersionRepository } from '@modules/versions/repository';
import { Target } from '@entities/event_handler.entity';
import { StepType } from '@entities/step.entity';
import { sanitizeComponentSection } from '../helpers/component-type-validator';
import { normalizeMalformedOptionsProperty } from '../helpers/component-options.utils';
import {
  ComponentUpdatePatch,
  isEmptyPatch,
  snapshotPreviousSection,
  wrapPatchSection,
} from '../helpers/component-update.helper';
import { generateComponentLayout, SiblingRect } from '../helpers/layout/generate-layout';

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
    private readonly versionRepository: VersionRepository,
    private readonly tooljetDbBulkUploadService: TooljetDbBulkUploadService,
    private readonly dataSourcesUtilService: DataSourcesUtilService,
    private readonly pluginsServiceSelector: PluginsServiceSelector,
    private readonly appEnvironmentUtilService: AppEnvironmentUtilService
  ) {}

  // Bare identifier only — no quoting escape needed since embedded double quotes are
  // rejected outright, and no other character can break out of the quoted form.
  private static readonly PG_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  private quotePgIdentifier(name: string): string {
    if (typeof name !== 'string' || !AgentsService.PG_IDENTIFIER_PATTERN.test(name)) {
      throw new Error(`"${name}" is not a valid PostgreSQL identifier`);
    }
    return `"${name}"`;
  }

  /**
   * Builds a `CREATE TABLE` DDL statement for an external PostgreSQL target (ticket #77 /
   * ADR-0025) from the same `tableParams` shape `buildTableParams` (service.ts) already
   * produces for ToolJet DB. `data_type` values come from TJDB_DATA_TYPES, which are already
   * valid PostgreSQL type names (ToolJet DB is Postgres) — no dialect translation needed.
   *
   * TODO(#77 follow-up): foreign_keys/indexes are not yet forwarded to the external DDL path
   * (ToolJet DB's `CreateTable` gets them via TooljetDbTableOperationsService; this path only
   * builds columns + a composite primary key so far). Out of this ticket's confirmed scope —
   * flagged rather than silently dropped.
   */
  private buildExternalCreateTableDdl(tableParams: any): string {
    const columnDefs: string[] = tableParams.columns.map((column: any) => {
      const parts = [this.quotePgIdentifier(column.column_name), column.data_type];
      if (column.constraints_type?.is_not_null) parts.push('NOT NULL');
      if (column.constraints_type?.is_unique) parts.push('UNIQUE');
      return parts.join(' ');
    });
    const primaryKeyColumns = tableParams.columns
      .filter((column: any) => column.constraints_type?.is_primary_key)
      .map((column: any) => this.quotePgIdentifier(column.column_name));
    if (primaryKeyColumns.length) {
      columnDefs.push(`PRIMARY KEY (${primaryKeyColumns.join(', ')})`);
    }
    return `CREATE TABLE ${this.quotePgIdentifier(tableParams.table_name)} (${columnDefs.join(', ')})`;
  }

  /**
   * Resolves a connected data source's live QueryService + parsed sourceOptions (the same
   * pair `DataQueriesUtilService.runQuery` assembles to run a query), so a raw SQL string can
   * be issued against it. Used only for the external `CreateTable` path (ticket #77) — every
   * other write in this system stays inside ToolJet DB.
   */
  private async runExternalSql(organizationId: string, dataSource: any, query: string): Promise<any> {
    const dsvOptions = await this.appEnvironmentUtilService.getOptions(dataSource.id, organizationId);
    const sourceOptions = await this.dataSourcesUtilService.parseSourceOptions(
      dsvOptions.options,
      organizationId,
      dsvOptions.environmentId
    );
    const service = await this.pluginsServiceSelector.getService(dataSource.pluginId, dataSource.kind);
    const result = await service.run(sourceOptions, { mode: 'sql', query } as any);
    if (result?.status === 'failed') {
      throw new Error(result?.errorMessage || 'External SQL execution against the connected data source failed');
    }
    return result;
  }

  /**
   * Ticket #77 / ADR-0042: creates a table in a connected PostgreSQL data source instead of
   * ToolJet DB — the DDL analogue of `CreateTable` above. `tableParams` is the same shape
   * `buildTableParams` builds; the caller (executeCreateTableStep) has already run the
   * ADR-0025 confirmation gate and the plan-time collision check before this is ever called,
   * so no DDL is issued here without both.
   */
  async CreateExternalTable(
    organizationId: string,
    dataSourceId: string,
    tableParams: any
  ): Promise<{ id: string; table_name: string }> {
    const dataSource = await this.dataSourcesRepository.findById(dataSourceId, organizationId);
    if (!dataSource || dataSource.kind !== 'postgresql') {
      throw new Error(`Data source ${dataSourceId} is not a connected PostgreSQL source`);
    }
    const ddl = this.buildExternalCreateTableDdl(tableParams);
    await this.runExternalSql(organizationId, dataSource, ddl);
    return { id: dataSource.id, table_name: tableParams.table_name };
  }

  /**
   * Ticket #77 / ADR-0042: inserts planner-proposed seed rows (ADR-0024's mechanism, reused
   * verbatim) into a table just created by CreateExternalTable. One INSERT per row, same
   * per-row reporting shape as SeedTable, so the run UI shows the same thing for either
   * target. A row's values are inlined as SQL literals (parameterized placeholders aren't
   * available through the plugin's ad-hoc `run` path) — every value is a JSON-safe primitive
   * (isWellFormedSeedRows already enforces this), so each is quoted as a literal rather than
   * concatenated as trusted SQL.
   */
  async SeedExternalTable(
    organizationId: string,
    dataSourceId: string,
    tableName: string,
    rows: Record<string, any>[]
  ): Promise<SeedTableReport> {
    const dataSource = await this.dataSourcesRepository.findById(dataSourceId, organizationId);
    if (!dataSource || dataSource.kind !== 'postgresql') {
      throw new Error(`Data source ${dataSourceId} is not a connected PostgreSQL source`);
    }
    const report: SeedTableReport = { total: rows.length, inserted: 0, updated: 0, failed: 0, failures: [] };

    for (const [index, row] of rows.entries()) {
      try {
        const columns = Object.keys(row);
        const columnList = columns.map((column) => this.quotePgIdentifier(column)).join(', ');
        const valueList = columns.map((column) => this.pgLiteral(row[column])).join(', ');
        const insertSql = `INSERT INTO ${this.quotePgIdentifier(tableName)} (${columnList}) VALUES (${valueList})`;
        await this.runExternalSql(organizationId, dataSource, insertSql);
        report.inserted += 1;
      } catch (error) {
        report.failed += 1;
        report.failures.push({ row: index + 1, error: error?.message || 'Unknown seed error' });
      }
    }

    if (report.total > 0 && report.failed === report.total) {
      throw new Error(`Seeding the external table failed: ${report.failures[0].error}`);
    }
    return report;
  }

  private pgLiteral(value: string | number | boolean | null): string {
    if (value === null) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    return `'${String(value).replace(/'/g, "''")}'`;
  }

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
   * Fetches a table's current schema ({ foreign_keys, columns, configurations }) via the
   * 'view_table' action (ticket #111). This — not the LLM's memory — is what an
   * update_table step diffs its full-replace payload against (ADR-0041).
   */
  async ViewTable(organizationId: string, tableName: string): Promise<any> {
    return this.tooljetDbTableOperationsService.perform(organizationId, 'view_table', { table_name: tableName });
  }

  /**
   * Applies an update_table step's diffed column entries via the 'edit_table' action
   * (ticket #111). `columns` is editTable's own per-column entry shape
   * ({ old_column, new_column }), produced deterministically by update-table-diff.ts;
   * empty new_column drops, empty old_column adds, both present alters (incl. renames).
   */
  async UpdateTable(organizationId: string, params): Promise<any> {
    return this.tooljetDbTableOperationsService.perform(organizationId, 'edit_table', params);
  }

  /**
   * Lists the organization's ToolJet DB tables ({ id, tableName }), for AI-step validation
   * that needs to know what already exists (ticket #23's foreign-key pre-flight). Errors
   * propagate to the caller.
   */
  async ViewTables(organizationId: string): Promise<Array<{ id: string; tableName: string }>> {
    return this.tooljetDbTableOperationsService.perform(organizationId, 'view_tables');
  }

  /**
   * Inserts seed rows into an already-created ToolJet DB table (ticket #48, per-query
   * reporting per ticket #62). Each row is executed as its own upsert query — a row
   * carrying the primary key values upserts (the planner-provable equivalent of the study
   * apps' `INSERT … ON CONFLICT DO NOTHING`), a row omitting a serial primary key
   * plain-INSERTs with the value auto-generated — and every operation's outcome (status,
   * row counts, error) lands in the returned report so the run UI can show what actually
   * landed in the table.
   *
   * A failed row does not abort the remaining ones (ticket #62): the report accumulates
   * partial success. Only a seed where *every* row failed throws into the Step-execution
   * retry loop — that means the error is systematic (bad table, bad primary keys), while
   * one bad row among successes would just fail the same way again on retry.
   */
  async SeedTable(
    organizationId: string,
    tableId: string,
    primaryKeyColumns: string[],
    rows: Record<string, any>[]
  ): Promise<SeedTableReport> {
    const report: SeedTableReport = { total: rows.length, inserted: 0, updated: 0, failed: 0, failures: [] };

    for (const [index, row] of rows.entries()) {
      let result;
      try {
        result = await this.tooljetDbBulkUploadService.bulkUpsertRowsWithPrimaryKey(
          [row],
          tableId,
          primaryKeyColumns,
          organizationId
        );
      } catch (error) {
        result = { status: 'failed', error: error?.message, inserted: 0, updated: 0 };
      }

      if (result?.status === 'failed') {
        report.failed += 1;
        report.failures.push({ row: index + 1, error: result.error || 'Unknown seed error' });
        continue;
      }
      report.inserted += result.inserted ?? 0;
      report.updated += result.updated ?? 0;
    }

    if (report.total > 0 && report.failed === report.total) {
      throw new Error(`Seeding the table failed: ${report.failures[0].error}`);
    }
    return report;
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
    if (type === 'TextArea') {
      return this.createTextAreaComponent(appVersionId, props);
    }
    if (type === 'PasswordInput') {
      return this.createPasswordInputComponent(appVersionId, props);
    }
    if (type === 'NumberInput') {
      return this.createNumberInputComponent(appVersionId, props);
    }
    if (type === 'EmailInput') {
      return this.createEmailInputComponent(appVersionId, props);
    }
    if (type === 'Link') {
      return this.createLinkComponent(appVersionId, props);
    }
    if (type === 'Divider') {
      return this.createDividerComponent(appVersionId, props);
    }
    if (type === 'Icon') {
      return this.createIconComponent(appVersionId, props);
    }
    if (type === 'StarRating') {
      return this.createStarRatingComponent(appVersionId, props);
    }
    if (type === 'Statistics') {
      return this.createStatisticsComponent(appVersionId, props);
    }
    if (type === 'Tags') {
      return this.createTagsComponent(appVersionId, props);
    }
    if (type === 'CurrencyInput') {
      return this.createCurrencyInputComponent(appVersionId, props);
    }
    if (type === 'PhoneInput') {
      return this.createPhoneInputComponent(appVersionId, props);
    }
    if (type === 'Datepicker') {
      return this.createDatepickerComponent(appVersionId, props);
    }
    if (type === 'Tabs') {
      return this.createTabsComponent(appVersionId, props);
    }
    if (type === 'Listview') {
      return this.createListviewComponent(appVersionId, props);
    }
    if (type === 'IFrame') {
      return this.createIFrameComponent(appVersionId, props);
    }
    if (type === 'FilePicker') {
      return this.createFilePickerComponent(appVersionId, props);
    }
    if (type === 'ModalV2') {
      return this.createModalV2Component(appVersionId, props);
    }
    if (type === 'TreeSelect') {
      return this.createTreeSelectComponent(appVersionId, props);
    }
    if (type === 'Html') {
      return this.createHtmlComponent(appVersionId, props);
    }
    if (type === 'PopoverMenu') {
      return this.createPopoverMenuComponent(appVersionId, props);
    }
    if (type === 'ButtonGroupV2') {
      return this.createButtonGroupComponent(appVersionId, props);
    }
    if (type === 'DatePickerV2') {
      return this.createDatePickerV2Component(appVersionId, props);
    }
    if (type === 'Chat') {
      return this.createChatComponent(appVersionId, props);
    }
    throw new Error(`Unsupported component type "${type}"`);
  }

  /**
   * UpdateComponent (ticket #66, port of the EE `updateComponent`/`updateSingleComponent`
   * idea): merges a sparse patch — only the properties/styles paths that actually changed,
   * `{}` meaning "no changes" — onto an existing component already in this app. The merge
   * itself happens in ComponentsService.update's own `_.mergeWith`; this method's job is to
   * resolve the real target (a nonexistent componentId must fail loudly, never fall through
   * to creating a clone), sanitize the patch against componentsMeta the same way
   * createWidgetComponent does (ticket #60), and snapshot exactly the touched keys' prior
   * values so `undoUpdateComponent` can restore them on rewind.
   */
  async UpdateComponent(
    appVersionId: string,
    organizationId: string,
    componentId: string,
    patch: ComponentUpdatePatch
  ): Promise<any> {
    let current: any;
    try {
      current = await this.componentsService.findOneWithLayouts(componentId);
    } catch {
      throw new Error(`Component "${componentId}" does not exist`);
    }

    if (isEmptyPatch(patch)) {
      return { id: componentId, type: current.type, pageId: current.pageId, patch: {}, previous: {}, noop: true };
    }

    const wrappedProperties = wrapPatchSection(patch.properties);
    const wrappedStyles = wrapPatchSection(patch.styles);

    const previous = {
      properties: snapshotPreviousSection(current.properties, patch.properties),
      styles: snapshotPreviousSection(current.styles, patch.styles),
    };

    const sanitizedProperties = wrappedProperties
      ? sanitizeComponentSection(current.type, 'properties', wrappedProperties)
      : undefined;
    const sanitizedStyles = wrappedStyles ? sanitizeComponentSection(current.type, 'styles', wrappedStyles) : undefined;

    const warnings = [...(sanitizedProperties?.warnings ?? []), ...(sanitizedStyles?.warnings ?? [])];
    if (warnings.length) {
      this.logger.warn(`[UpdateComponent] ${current.type} sanitized: ${JSON.stringify(warnings)}`);
    }

    const definition: Record<string, any> = {};
    if (sanitizedProperties) definition.properties = sanitizedProperties.result;
    if (sanitizedStyles) definition.styles = sanitizedStyles.result;

    await this.componentsService.update({ [componentId]: { component: { definition } } }, appVersionId);

    return {
      id: componentId,
      type: current.type,
      pageId: current.pageId,
      patch: definition,
      previous,
      ...(warnings.length && { warnings }),
    };
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
  private readonly logger = new Logger(AgentsService.name);

  /**
   * Ticket #60: every assembled property/style of an LLM-generated widget is
   * validated against the widget's componentsMeta before the diff is written —
   * unknown keys are dropped and invalid values fall back to the widget
   * defaults, each with a warning. Options structures get a structural repair
   * pass. Warnings ride on the returned artifact content (and the server log),
   * so a hallucinated property degrades to a warn instead of breaking render.
   */
  private sanitizeWidgetDefinition(
    type: string,
    properties: Record<string, any>,
    styles: Record<string, any>
  ): { properties: Record<string, any>; styles: Record<string, any>; warnings: string[] } {
    // Options run first: the normalizer repairs string/char-array LLM output into a real
    // array, so the section sanitizer (which expects the widget's array-shaped default)
    // doesn't mistake recoverable options for a type error and drop them.
    const { warnings: optionsWarnings } = normalizeMalformedOptionsProperty(type, properties);
    const { result: sanitizedProperties, warnings: propertyWarnings } = sanitizeComponentSection(
      type,
      'properties',
      properties
    );
    const { result: sanitizedStyles, warnings: styleWarnings } = sanitizeComponentSection(type, 'styles', styles);
    const warnings = [...optionsWarnings, ...propertyWarnings, ...styleWarnings];
    if (warnings.length) {
      this.logger.warn(`[createWidgetComponent] ${type} sanitized: ${JSON.stringify(warnings)}`);
    }
    return { properties: sanitizedProperties, styles: sanitizedStyles, warnings };
  }

  /**
   * Ticket #63: the layout footprint passed by each builder is the widget's desired
   * size only — top/left are computed deterministically here (never by the LLM) from
   * the ToolJet grid rules and the page's existing root-level components, so new
   * widgets never overlap their siblings. Tabs gets its fixed full-page layout
   * (one per page), and when the page is too full the existing siblings are
   * compacted and their recomputed tops written back.
   */
  private async createWidgetComponent(
    appVersionId: string,
    pageId: string,
    type: string,
    name: string,
    properties: Record<string, any>,
    styles: Record<string, any>,
    layout: { width: number; height: number }
  ): Promise<{ id: string; pageId: string; type: string; warnings?: string[] }> {
    const componentId = uuidv4();
    const sanitized = this.sanitizeWidgetDefinition(type, properties, styles);

    const existingComponents = await this.componentsService.getAllComponents(pageId);
    const siblings: SiblingRect[] = Object.entries(existingComponents ?? {})
      .map(([id, entry]) => ({
        id,
        type: entry?.component?.component,
        parent: entry?.component?.parent,
        left: entry?.layouts?.desktop?.left,
        top: entry?.layouts?.desktop?.top,
        width: entry?.layouts?.desktop?.width,
        height: entry?.layouts?.desktop?.height,
      }))
      .filter(
        (rect) =>
          !rect.parent &&
          [rect.left, rect.top, rect.width, rect.height].every(
            (value) => typeof value === 'number' && Number.isFinite(value)
          )
      )
      .map(({ id, type: siblingType, left, top, width, height }) => ({
        id,
        type: siblingType,
        left,
        top,
        width,
        height,
      }));

    const { layout: placedLayout, siblingUpdates } = generateComponentLayout(type, siblings, layout);

    if (siblingUpdates) {
      const layoutDiff = Object.fromEntries(
        Object.entries(siblingUpdates).map(([id, update]) => [id, { layouts: { desktop: update } }])
      );
      // componentLayoutChange reports failures (e.g. a vanished component) as a
      // resolved { error } instead of throwing — creating the new component at
      // coordinates that assume compaction happened would guarantee overlap.
      const result = await this.componentsService.componentLayoutChange(layoutDiff, appVersionId);
      if (result?.error) {
        throw new Error(`Sibling layout compaction failed: ${result.error.message}`);
      }
    }

    const componentDiff = {
      [componentId]: {
        name,
        type,
        parent: null,
        properties: sanitized.properties,
        styles: sanitized.styles,
        layouts: {
          desktop: placedLayout,
        },
      },
    };

    // ComponentsService.create's own return value carries no useful data (it resolves to
    // {} — see component.service.ts's dbTransactionForAppVersionAssociationsUpdate wrapper);
    // componentId is already known since it's generated here, so nothing is lost.
    await this.componentsService.create(componentDiff, pageId, appVersionId);
    return { id: componentId, pageId, type, warnings: sanitized.warnings };
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

  // defaultSize per textarea.js: { width: 10, height: 100 }.
  private async createTextAreaComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder, value } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'TextArea',
      label || 'Textarea',
      {
        label: { value: label || 'Label' },
        placeholder: { value: placeholder || '' },
        value: { value: value || '' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 100 }
    );
  }

  // defaultSize per passwordinput.js: { width: 10, height: 40 }.
  private async createPasswordInputComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'PasswordInput',
      label || 'PasswordInput',
      {
        label: { value: label || 'Label' },
        placeholder: { value: placeholder || 'Password' },
        value: { value: '' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per numberinput.js: { width: 10, height: 40 }.
  private async createNumberInputComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder, defaultValue } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'NumberInput',
      label || 'NumberInput',
      {
        label: { value: label || 'Label' },
        placeholder: { value: placeholder || '' },
        value: { value: defaultValue ?? 0 },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per emailinput.js: { width: 10, height: 40 }.
  private async createEmailInputComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'EmailInput',
      label || 'EmailInput',
      {
        label: { value: label || 'Label' },
        placeholder: { value: placeholder || 'Enter email' },
        value: { value: '' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per link.js: { width: 6, height: 30 }.
  private async createLinkComponent(appVersionId: string, props: any) {
    const { pageId, text, url, openInNewTab = true } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Link',
      text || 'Link',
      {
        linkText: { value: text || 'Click here' },
        linkTarget: { value: url || 'https://dev.to/' },
        targetType: { value: openInNewTab ? 'new' : 'same' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 6, height: 30 }
    );
  }

  // defaultSize per divider.js: { width: 10, height: 10 }.
  private async createDividerComponent(appVersionId: string, props: any) {
    const { pageId, label } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Divider',
      label || 'Divider',
      {
        label: { value: label || '' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 10 }
    );
  }

  // defaultSize per icon.js: { width: 5, height: 48 }. `icon` is a Tabler icon name
  // (e.g. "IconHome2") — no catalog validated here, an unknown name just renders blank.
  private async createIconComponent(appVersionId: string, props: any) {
    const { pageId, icon } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Icon',
      'Icon',
      {
        icon: { value: icon || 'IconHome2' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 5, height: 48 }
    );
  }

  // defaultSize per starrating.js: { width: 10, height: 30 }. Meta carries this widget's
  // legacy `visible` property name (not `visibility`, unlike every other widget here).
  private async createStarRatingComponent(appVersionId: string, props: any) {
    const { pageId, label, maxRating = 5, defaultSelected = 0 } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'StarRating',
      label || 'StarRating',
      {
        label: { value: label || 'Select your rating' },
        maxRating: { value: String(maxRating) },
        defaultSelected: { value: String(defaultSelected) },
        visible: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 30 }
    );
  }

  // defaultSize per statistics.js: { width: 10, height: 152 }.
  private async createStatisticsComponent(appVersionId: string, props: any) {
    const { pageId, primaryLabel, primaryValue, secondaryLabel, secondaryValue } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Statistics',
      primaryLabel || 'Statistics',
      {
        primaryValueLabel: { value: primaryLabel || 'This months earnings' },
        primaryValue: { value: primaryValue ?? '682.3' },
        ...(secondaryLabel ? { secondaryValueLabel: { value: secondaryLabel } } : {}),
        ...(secondaryValue !== undefined ? { secondaryValue: { value: secondaryValue } } : {}),
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 152 }
    );
  }

  // defaultSize per tags.js: { width: 9, height: 30 }. `data` is the widget's own binding —
  // a templated array of { title, color, textColor } objects, cycled from a small fixed
  // palette so an arbitrary-length tag list still renders with distinguishable colors.
  private static readonly TAG_PALETTE = [
    { color: '#34A94733', textColor: '#34A947' },
    { color: '#405DE61A', textColor: '#405DE6' },
    { color: '#F357171A', textColor: '#F35717' },
    { color: '#EB2E3933', textColor: '#EB2E39' },
  ];

  private async createTagsComponent(appVersionId: string, props: any) {
    const { pageId, tags } = props ?? {};
    const list = (tags?.length ? tags : ['success', 'info', 'warning', 'danger']).map(
      (title: string, index: number) => ({
        title,
        ...AgentsService.TAG_PALETTE[index % AgentsService.TAG_PALETTE.length],
      })
    );
    const dataLiteral = list
      .map((tag: any) => `{ title: '${String(tag.title).replace(/'/g, "\\'")}', color: '${tag.color}', textColor: '${tag.textColor}' }`)
      .join(', \n\t\t');
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Tags',
      'Tags',
      {
        data: { value: `{{ [ \n\t\t${dataLiteral} ] }}` },
      },
      {},
      { width: 9, height: 30 }
    );
  }

  // defaultSize per currencyinput.js: { width: 10, height: 40 }.
  private async createCurrencyInputComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder, defaultValue } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'CurrencyInput',
      label || 'CurrencyInput',
      {
        label: { value: label || 'Label' },
        placeholder: { value: placeholder || 'Enter your number' },
        value: { value: defaultValue ?? 0 },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per phoneinput.js: { width: 10, height: 40 }.
  private async createPhoneInputComponent(appVersionId: string, props: any) {
    const { pageId, label, placeholder } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'PhoneInput',
      label || 'PhoneInput',
      {
        label: { value: label || 'Label' },
        placeholder: { value: placeholder || 'Enter your input' },
        value: { value: '' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per datepicker.js (legacy 'Datepicker' component): { width: 5, height: 40 }.
  // Meta carries `visibility`/`disabledState` under styles, not properties — a quirk of this
  // legacy widget's own definition, not a bug here.
  private async createDatepickerComponent(appVersionId: string, props: any) {
    const { pageId, defaultValue, placeholder, format } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Datepicker',
      'Datepicker',
      {
        defaultValue: { value: defaultValue || '01/01/2022' },
        placeholder: { value: placeholder || 'Select date' },
        format: { value: format || 'DD/MM/YYYY' },
      },
      {
        visibility: { value: '{{true}}' },
      },
      { width: 5, height: 40 }
    );
  }

  // Wave 2 (plan increment 3) — more complex widgets, still standalone/empty like Container
  // and Modal above: nesting children into them (Tabs panes, Listview items, ModalV2 body)
  // isn't wired up yet — that's increment 4's `parentComponentId` work, not this ticket's.

  // defaultSize per tabs.js: { width: 15, height: 450 }, but generateComponentLayout special-
  // cases 'Tabs' to TABS_FIXED_LAYOUT regardless of the size passed here (one Tabs per page).
  private async createTabsComponent(appVersionId: string, props: any) {
    const { pageId, tabs } = props ?? {};
    const titles = tabs?.length ? tabs : ['Home', 'Profile', 'Settings'];
    const tabsLiteral = titles
      .map((title: string, index: number) => `{ title: '${String(title).replace(/'/g, "\\'")}', id: '${index}' }`)
      .join(', \n\t\t');
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Tabs',
      'Tabs',
      {
        tabs: { value: `{{[ \n\t\t${tabsLiteral} \n ]}}` },
        defaultTab: { value: '0' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 15, height: 450 }
    );
  }

  // defaultSize per listview.js: { width: 15, height: 450 }. Binds to a query's data when
  // one is referenced, otherwise keeps the widget's own stock demo rows.
  private async createListviewComponent(appVersionId: string, props: any) {
    const { pageId, queryName } = props ?? {};
    const created = await this.createWidgetComponent(
      appVersionId,
      pageId,
      'Listview',
      'Listview',
      {
        ...(queryName ? { data: { value: `{{queries.${queryName}.data}}` } } : {}),
        mode: { value: 'list' },
        visible: { value: '{{true}}' },
      },
      {},
      { width: 15, height: 450 }
    );
    return { ...created, queryName };
  }

  // defaultSize per iframe.js: { width: 10, height: 310 }.
  private async createIFrameComponent(appVersionId: string, props: any) {
    const { pageId, source } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'IFrame',
      'IFrame',
      {
        source: { value: source || 'https://tooljet.com' },
        visible: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 310 }
    );
  }

  // defaultSize per filepicker.js: { width: 15, height: 140 }.
  private async createFilePickerComponent(appVersionId: string, props: any) {
    const { pageId, label } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'FilePicker',
      label || 'FilePicker',
      {
        label: { value: label || 'Upload files' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 15, height: 140 }
    );
  }

  // defaultSize per modalV2.js: { width: 10, height: 40 }. Newer sibling of the legacy Modal
  // builder above; unlike it, ModalV2 has no `title` property of its own — its header content
  // is a child slot, which (like every widget here) isn't nestable yet.
  private async createModalV2Component(appVersionId: string, props: any) {
    const { pageId, triggerButtonLabel } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'ModalV2',
      'Modal',
      {
        useDefaultButton: { value: '{{true}}' },
        triggerButtonLabel: { value: triggerButtonLabel || 'Launch Modal' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per treeSelect.js: { width: 12, height: 200 }. Keeps the widget's own stock
  // demo tree — building a real hierarchy from a flat prop list is out of this ticket's scope.
  private async createTreeSelectComponent(appVersionId: string, props: any) {
    const { pageId, label } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'TreeSelect',
      label || 'TreeSelect',
      {
        label: { value: label || 'Options' },
      },
      {},
      { width: 12, height: 200 }
    );
  }

  // defaultSize per html.js: { width: 10, height: 310 }.
  private async createHtmlComponent(appVersionId: string, props: any) {
    const { pageId, html } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Html',
      'Html',
      {
        rawHtml: { value: html || '<div>Hello world</div>' },
      },
      {},
      { width: 10, height: 310 }
    );
  }

  // defaultSize per popoverMenu.js: { width: 6, height: 40 }. `options` mirrors DropdownV2's
  // list shape (createDropdownComponent), plus the icon/disable wrappers PopoverMenu itself
  // stores per entry.
  private async createPopoverMenuComponent(appVersionId: string, props: any) {
    const { pageId, label, options } = props ?? {};
    const list = (options?.length ? options : ['option1', 'option2', 'option3']).map(
      (option: string, index: number) => ({
        format: 'plain',
        label: String(option),
        description: '',
        value: String(index + 1),
        icon: { value: 'IconBolt' },
        iconVisibility: false,
        disable: { value: false },
        visible: { value: true },
      })
    );
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'PopoverMenu',
      label || 'PopoverMenu',
      {
        label: { value: label || 'Menu' },
        options: { value: list },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 6, height: 40 }
    );
  }

  // defaultSize per buttonGroupV2.js: { width: 12, height: 80 }.
  private async createButtonGroupComponent(appVersionId: string, props: any) {
    const { pageId, label, options } = props ?? {};
    const list = (options?.length ? options : ['Button1', 'Button2', 'Button3']).map(
      (option: string, index: number) => ({
        label: String(option),
        value: String(index + 1),
        icon: { value: 'IconBolt' },
        iconVisibility: false,
        disable: { value: false },
        default: { value: index === 0 },
      })
    );
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'ButtonGroupV2',
      label || 'ButtonGroup',
      {
        label: { value: label || 'Label' },
        options: { value: list },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 12, height: 80 }
    );
  }

  // defaultSize per datepickerV2.js: { width: 10, height: 40 }. Unlike the legacy Datepicker
  // builder above, visibility lives under properties here (matches the current widget).
  private async createDatePickerV2Component(appVersionId: string, props: any) {
    const { pageId, label, defaultValue, placeholder, format } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'DatePickerV2',
      label || 'DatePicker',
      {
        label: { value: label || 'Label' },
        defaultValue: { value: defaultValue || '01/01/2022' },
        placeholder: { value: placeholder || 'Select date' },
        dateFormat: { value: format || 'DD/MM/YYYY' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 10, height: 40 }
    );
  }

  // defaultSize per chat.js: { width: 15, height: 400 }. Decorative only — no query/event is
  // wired to actually send or receive messages (that needs increment 5/6 machinery this
  // ticket doesn't build); the tool description flags it experimental for the same reason.
  private async createChatComponent(appVersionId: string, props: any) {
    const { pageId, chatTitle } = props ?? {};
    return this.createWidgetComponent(
      appVersionId,
      pageId,
      'Chat',
      chatTitle || 'Chat',
      {
        chatTitle: { value: chatTitle || 'Chat' },
        visibility: { value: '{{true}}' },
      },
      {},
      { width: 15, height: 400 }
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
   * Persists a merged options patch for an existing query (ticket #67). The patch has
   * already been merged into the query's full options and security-validated by the
   * caller (executeUpdateQueryStep); name/dataSourceId are structurally untouchable here
   * — only options is written.
   */
  async UpdateQuery(queryId: string, options: any): Promise<any> {
    return this.dataQueryRepository.updateOne(queryId, { options });
  }

  /**
   * The version's component inventory, keyed page id → component id → { name, type },
   * for event steps to resolve LLM-named target components (ticket #67). PageService's
   * page ids are the keys ComponentsService returns components for.
   */
  async ListComponents(appVersionId: string): Promise<Record<string, Record<string, any>>> {
    const pages = await this.pageService.findPagesForVersion(appVersionId);
    const componentsByPage = await this.componentsService.getAllComponentsForPages(pages.map((page) => page.id));
    // getAllComponentsForPages returns id → { component, layouts }; project down to what
    // event grounding needs (name + type), not the full widget definition.
    const inventory: Record<string, Record<string, any>> = {};
    for (const [componentId, entry] of Object.entries(componentsByPage ?? {})) {
      const component = (entry as any)?.component;
      if (!component) continue;
      inventory[component.page_id] ??= {};
      inventory[component.page_id][componentId] = { name: component.name, type: component.component };
    }
    return inventory;
  }

  async FindEventsBySource(sourceId: string): Promise<any[]> {
    return this.eventsService.findAllEventsWithSourceId(sourceId);
  }

  async CreateEvent(appVersionId: string, eventHandler: any): Promise<any> {
    // skipHistoryCapture: the AI step's own change is already recorded as the Step's
    // Artifact (and is rewound through it) — an EE app-history entry on top would double-count.
    return this.eventsService.createEvent(eventHandler, appVersionId, true);
  }

  async UpdateEventBody(appVersionId: string, eventId: string, event: any): Promise<any> {
    return this.eventsService.updateEvent([{ event_id: eventId, diff: { event } } as any], 'update', appVersionId);
  }

  async DeleteEvent(appVersionId: string, eventId: string): Promise<any> {
    return this.eventsService.deleteEvent(eventId, appVersionId);
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
      case 'UpdateComponent':
        return this.undoUpdateComponent(appVersionId, content);
      case 'UpdateQuery':
        return this.undoUpdateQuery(content);
      case 'GenerateEvent':
        return this.undoGenerateEvent(appVersionId, content);

      default:
        throw new Error(`Cannot undo unsupported step type "${stepType}"`);
    }
  }

  // Ticket #77 / ADR-0042: Rewind needs no special-casing for the external-target case —
  // undoArtifact dispatches the same way it always has, on StepType alone. The Artifact
  // content of an external CreateTable step (set by executeCreateTableStep) carries
  // `targetDataSourceId`; its presence is what routes the drop to the external connection
  // instead of ToolJet DB, mirroring the create path's own dispatch.
  private async undoCreateTable(organizationId: string, content: any): Promise<void> {
    if (content?.targetDataSourceId) {
      const dataSource = await this.dataSourcesRepository.findById(content.targetDataSourceId, organizationId);
      if (!dataSource) return; // Source disconnected since — nothing left to drop through it.
      await this.runExternalSql(
        organizationId,
        dataSource,
        `DROP TABLE IF EXISTS ${this.quotePgIdentifier(content.table_name)}`
      );
      return;
    }
    await this.tooljetDbTableOperationsService.perform(organizationId, 'drop_table', {
      table_name: content.table_name,
    });
  }

  private async undoQuery(queryId: string): Promise<void> {
    await this.dataQueryRepository.deleteDataQueryEvents(queryId);
    await this.dataQueryRepository.deleteOne(queryId);
  }

  // Ticket #67: an UpdateQuery artifact carries the query's full previous options, so the
  // undo is a plain write-back — the patch never touched name/dataSourceId, and rewinding
  // the merged options restores exactly what was there before.
  private async undoUpdateQuery(content: any): Promise<void> {
    if (!content?.queryId || content?.previousOptions === undefined) {
      throw new Error('UpdateQuery artifact is missing queryId/previousOptions — cannot undo');
    }
    await this.UpdateQuery(content.queryId, content.previousOptions);
  }

  // Ticket #67: undo for events goes in reverse creation order — first restore the bodies
  // of events the step updated (previousEvent), then delete the ones it created. If a
  // restored event has since vanished the update is a no-op result, not an error.
  private async undoGenerateEvent(appVersionId: string, content: any): Promise<void> {
    const updated: any[] = content?.updated ?? [];
    for (const entry of [...updated].reverse()) {
      await this.UpdateEventBody(appVersionId, entry.id, entry.previousEvent);
    }
    const created: any[] = content?.created ?? [];
    for (const entry of [...created].reverse()) {
      await this.DeleteEvent(appVersionId, entry.id);
    }
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

  /**
   * Compensating undo for UpdateComponent (ticket #66): re-merges the pre-patch snapshot
   * `UpdateComponent` captured back onto the component, through the same
   * ComponentsService.update merge path the original patch used. A no-op patch ({}) left
   * nothing to restore. Known gap: a patch that introduced a property/style the component
   * had no prior value for is snapshotted as absent (see component-update.helper.ts), so
   * undo cannot fully un-introduce it — it restores every value that changed, not
   * necessarily the component's exact prior shape in that one edge case.
   */
  private async undoUpdateComponent(appVersionId: string, content: any): Promise<void> {
    if (content?.noop) return;

    const definition: Record<string, any> = {};
    if (content?.previous?.properties && Object.keys(content.previous.properties).length) {
      definition.properties = content.previous.properties;
    }
    if (content?.previous?.styles && Object.keys(content.previous.styles).length) {
      definition.styles = content.previous.styles;
    }
    if (!Object.keys(definition).length) return;

    await this.componentsService.update({ [content.id]: { component: { definition } } }, appVersionId);
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
