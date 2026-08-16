import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { IAgentsService } from '../interfaces/IAgentsService';
import { TooljetDbTableOperationsService } from '@modules/tooljet-db/services/tooljet-db-table-operations.service';
import { PageService } from '@modules/apps/services/page.service';
import { ComponentsService } from '@modules/apps/services/component.service';
import { DataQueryRepository } from '@modules/data-queries/repository';
import { DataSourcesRepository } from '@modules/data-sources/repository';

@Injectable()
export class AgentsService implements IAgentsService {
  constructor(
    private readonly tooljetDbTableOperationsService: TooljetDbTableOperationsService,
    private readonly pageService: PageService,
    private readonly componentsService: ComponentsService,
    private readonly dataQueryRepository: DataQueryRepository,
    private readonly dataSourcesRepository: DataSourcesRepository
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
   * `props`'s shape depends on `type` (v1 subset: 'Page', 'Table' — the rest of ADR-0002's
   * allow-list lands in a later ticket):
   *  - 'Page':  { name }
   *  - 'Table': { pageId, title, queryName } — pageId is an earlier CreateComponent(Page)
   *    step's Artifact id, queryName an earlier CreateQuery step's query name; the table's
   *    `data` property is bound to it as `{{queries.<queryName>.data}}`.
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
   * Deliberately minimal Table properties/styles — enough to actually render and show
   * bound data (dataSourceSelector + data + autogenerateColumns), not a full mirror of
   * frontend/src/AppBuilder/WidgetManager/widgets/table.js's much larger default set,
   * which isn't reachable from server-side code. `layouts.desktop` uses that widget's own
   * `defaultSize` ({ width: 25, height: 460 }) so the table has a sane footprint on canvas.
   */
  private async createTableComponent(appVersionId: string, props: any) {
    const { pageId, title, queryName } = props ?? {};
    const componentId = uuidv4();
    const componentDiff = {
      [componentId]: {
        name: title || 'Table',
        type: 'Table',
        parent: null,
        properties: {
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
        styles: {
          columnTitleColor: { value: 'var(--cc-primary-text)' },
          containerBackgroundColor: { value: 'var(--cc-surface1-surface)' },
          textColor: { value: 'var(--cc-primary-text)' },
          borderColor: { value: 'var(--cc-weak-border)' },
          borderRadius: { value: '6' },
          tableType: { value: 'table-classic' },
        },
        layouts: {
          desktop: { top: 0, left: 0, width: 25, height: 460 },
        },
      },
    };

    // ComponentsService.create's own return value carries no useful data (it resolves to
    // {} — see component.service.ts's dbTransactionForAppVersionAssociationsUpdate wrapper);
    // componentId is already known since it's generated here, so nothing is lost.
    await this.componentsService.create(componentDiff, pageId, appVersionId);
    return { id: componentId, pageId, type: 'Table', queryName };
  }

  /**
   * `props`: { name, options } — options is TooljetDbDataOperationsService's query-options
   * shape (e.g. { operation: 'list_rows', table_id, list_rows: {...} }). The built-in
   * ToolJet DB data source is per-organization (created once at org setup), looked up here
   * rather than passed in.
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
