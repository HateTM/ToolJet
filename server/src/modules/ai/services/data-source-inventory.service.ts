import { Injectable, Logger } from '@nestjs/common';
import { User } from '@entities/user.entity';
import { UserPermissions } from '@modules/ability/types';
import { DataSourcesRepository } from '@modules/data-sources/repository';
import { DataSourceTypes } from '@modules/data-sources/constants';
import { DataQueriesUtilService } from '@modules/data-queries/util.service';

/**
 * The connector kinds a generated `CreateQuery` step may target besides ToolJet DB
 * (ADR-0019). The list is the SQL family and nothing else, for one reason: every one of
 * these takes a query as a single `{ mode: 'sql', query }` string, so one prompt and one
 * tool schema cover all of them. A REST or document store would each need their own
 * request shape, which is a different ticket's worth of work rather than another entry here.
 *
 * `mariadb` is listed even though its plugin has no service-level `listTables` yet: a source
 * whose schema can't be read is dropped below, so listing it costs one caught error today
 * and starts working the day that method is added, with no change here.
 */
export const SQL_QUERYABLE_KINDS = ['postgresql', 'mysql', 'mariadb', 'mssql', 'oracledb'];

/**
 * Increment 5: a REST source has no schema to introspect — there is no `tables` list to
 * ground the model in, so it is queryable by name/id alone (the AI Builder gives it a
 * request path, not a table). Kept as its own list rather than folded into
 * `SQL_QUERYABLE_KINDS` because it changes both how the source survives `listQueryableSources`
 * (never dropped for having zero tables) and how it is rendered to the model
 * (`renderConnectedDataSources`).
 */
export const REST_QUERYABLE_KINDS = ['restapi'];

/**
 * Increment 5 (plugin branch): unlike `SQL_QUERYABLE_KINDS`/`REST_QUERYABLE_KINDS`, this is
 * deliberately not a hardcoded list of plugin kinds — that would drift the moment a new
 * marketplace plugin is installed. Queryable-ness for the ~40 non-SQL, non-REST connector
 * kinds is instead derived per-source, in `isPluginQueryable` below, from whether that
 * source's plugin manifest exposes an `operations.json` with a real `operation` dropdown
 * (`properties.operation.list`, a `[{ name, value }]` array — the shape
 * `operations.schema.json` governs, confirmed uniform across Slack/Airtable/Baserow/Google
 * Sheets/Mailgun). A plugin whose operations aren't a flat dropdown (Notion's
 * resource/database/page/block/user tree, Stripe's `spec_url`-driven OpenAPI operations) has
 * no equivalent to ground a tool call in and is silently excluded — the same tolerant
 * degradation `readTables` already gives a SQL source with an unreadable schema.
 */
const isPluginOperationList = (value: unknown): value is Array<{ name?: string; value: string }> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => entry && typeof entry === 'object' && typeof (entry as any).value === 'string');

export type QueryableDataSource = {
  id: string;
  name: string;
  kind: string;
  tables: string[];
  // Only set for a plugin-queryable source (see isPluginOperationList): the operation names
  // the model may pick from, e.g. [{ name: 'Send message', value: 'send_message' }].
  operations?: Array<{ name?: string; value: string }>;
};

// Bounds on what reaches the prompt. Both the planner and every CreateQuery step carry this
// block, so a warehouse with a thousand tables must not be able to crowd out the PRD itself.
const MAX_SOURCES = 10;
const MAX_TABLES_PER_SOURCE = 50;

/**
 * Reads a table name off one connector's `listTables` row. The row shape is not uniform
 * across the SQL plugins — Postgres/MySQL/MSSQL return `information_schema` rows
 * (`{ table_name, table_schema }`), Oracle returns option-picker rows (`{ value, label }`) —
 * and normalizing here is cheaper than making five plugins agree.
 *
 * The schema is kept, not dropped, whenever the connector reported one: `schema.table` is
 * valid in every dialect here, and a bare name is ambiguous the moment two schemas both hold
 * an `orders`. Showing the model a name it cannot actually select from would defeat the
 * point of reading the real schema at all.
 */
const readTableName = (row: any): string | null => {
  const name = row?.table_name ?? row?.value ?? row?.label;
  if (typeof name !== 'string' || !name.length) return null;

  const schema = row?.table_schema;
  return typeof schema === 'string' && schema.length ? `${schema}.${name}` : name;
};

/**
 * Postgres' `listTables` defaults to the `public` schema, so a source whose tables live
 * anywhere else reports none and would be dropped below as empty. The other SQL plugins
 * ignore this option — MySQL and MSSQL scope themselves to the connected database — except
 * Oracle, which reads it as an owner name and would find nothing under a literal "all".
 */
const listTablesOptionsFor = (kind: string) => (kind === 'postgresql' ? { schema: 'all' } : undefined);

/**
 * The connected-data-sources block both the planner and every CreateQuery step are grounded
 * in. Empty when nothing external is connected — which is every app that existed before this
 * feature — so those prompts stay exactly as they were rather than gaining a "none" line that
 * only invites the model to wonder what it is missing.
 */
export const renderConnectedDataSources = (dataSources: QueryableDataSource[]): string => {
  if (!dataSources?.length) return '';

  const lines = dataSources.map((dataSource) => {
    if (REST_QUERYABLE_KINDS.includes(dataSource.kind)) {
      return `- ${dataSource.name} (${dataSource.kind}), id ${dataSource.id} — a REST API; give a request path relative to its base URL`;
    }
    if (dataSource.operations?.length) {
      const ops = dataSource.operations.map((op) => op.value).join(', ');
      return `- ${dataSource.name} (${dataSource.kind}), id ${dataSource.id} — a plugin; operations: ${ops}`;
    }
    return `- ${dataSource.name} (${dataSource.kind}), id ${dataSource.id} — tables: ${dataSource.tables.join(', ')}`;
  });

  return [
    'Connected data sources (already configured by the user, queryable with SQL, an HTTP request for a REST source, or a named operation for a plugin source):',
    ...lines,
  ].join('\n');
};

@Injectable()
export class DataSourceInventoryService {
  private readonly logger = new Logger(DataSourceInventoryService.name);

  constructor(
    private readonly dataSourcesRepository: DataSourcesRepository,
    private readonly dataQueriesUtilService: DataQueriesUtilService
  ) {}

  /**
   * The already-connected external data sources a generated query may target, each with the
   * tables actually present in it. Used to ground both the step planner and the CreateQuery
   * step — the model can only pick a source and a table it is shown here (ADR-0019).
   *
   * Reached through `allGlobalDS`, the same permission-filtered listing the data source panel
   * and the query editor's picker use, rather than a lookup of its own. That is deliberate:
   * this list goes verbatim into a prompt and then into queries built against real
   * credentials, so "which sources may this user see" has to be answered by the code that
   * already answers it everywhere else, not by a second rule that can drift from it.
   *
   * A source is only included if its schema could be read *and* is non-empty. That is the
   * whole reason introspection happens at plan time rather than being skipped: without real
   * table names the model would invent them, and a query against a table that doesn't exist
   * fails at run time, long after the build reported success — this flow creates queries, it
   * never runs them, so nothing downstream would catch it.
   *
   * Nothing here is fatal. The inventory is an enrichment on top of a flow that has always
   * worked against ToolJet DB, so a failure to assemble it degrades to "no external sources
   * connected" rather than failing a build that never needed one.
   */
  async listQueryableSources(user: User, userPermissions: UserPermissions): Promise<QueryableDataSource[]> {
    let dataSources: Array<{
      id: string;
      name: string;
      kind: string;
      type?: string;
      plugin?: { operationsFile?: { data?: any } };
    }>;
    try {
      const visible = await this.dataSourcesRepository.allGlobalDS(userPermissions, user.organizationId, {});
      dataSources = (visible || [])
        // `allGlobalDS` appends the organization's sample data sources. Those are ToolJet's
        // own demo data rather than something the user connected, so nothing should propose
        // building an app against them.
        .filter((dataSource) => dataSource.type !== DataSourceTypes.SAMPLE)
        .filter(
          (dataSource) =>
            SQL_QUERYABLE_KINDS.includes(dataSource.kind) ||
            REST_QUERYABLE_KINDS.includes(dataSource.kind) ||
            // Plugin kinds aren't enumerated here (see isPluginOperationList's comment) — a
            // non-SQL, non-REST source is a plugin candidate and gets a real check below;
            // this filter only needs to not throw it away before that check runs.
            Boolean(dataSource.plugin)
        )
        .sort((left, right) => (left.name || '').localeCompare(right.name || ''));
    } catch (error) {
      this.logger.warn(`[dataSourceInventory] could not list data sources: ${error?.message}`);
      return [];
    }

    const queryable: QueryableDataSource[] = [];
    for (const dataSource of dataSources) {
      // Capped on what survives, not on what was found: ten unreachable sources must not be
      // able to hide the readable eleventh.
      if (queryable.length >= MAX_SOURCES) break;

      // A REST source has no schema to introspect — it is never dropped for having zero
      // tables, unlike a SQL source (whose empty `tables` means "could not read its schema").
      if (REST_QUERYABLE_KINDS.includes(dataSource.kind)) {
        queryable.push({ id: dataSource.id, name: dataSource.name, kind: dataSource.kind, tables: [] });
        continue;
      }

      if (!SQL_QUERYABLE_KINDS.includes(dataSource.kind)) {
        const operations = dataSource.plugin?.operationsFile?.data?.properties?.operation?.list;
        if (isPluginOperationList(operations)) {
          queryable.push({
            id: dataSource.id,
            name: dataSource.name,
            kind: dataSource.kind,
            tables: [],
            operations,
          });
        }
        // Not a SQL kind and no usable operation list — e.g. Notion's resource tree, Stripe's
        // spec-driven operations. Same silent-drop as an unreadable SQL schema; there is
        // nothing to ground a tool call in for this source, so it isn't offered.
        continue;
      }

      const tables = await this.readTables(user, dataSource);
      if (!tables.length) continue;
      queryable.push({ id: dataSource.id, name: dataSource.name, kind: dataSource.kind, tables });
    }
    return queryable;
  }

  /**
   * `environmentId` and `branchId` are deliberately left out: `getOptions` resolves the
   * organization's default environment when none is given, which is the same source the
   * generated query will be run against by someone opening the app in the editor.
   */
  private async readTables(user: User, dataSource: any): Promise<string[]> {
    try {
      const result: any = await this.dataQueriesUtilService.listTables(
        user,
        dataSource,
        undefined,
        undefined,
        listTablesOptionsFor(dataSource?.kind)
      );
      const payload = result?.data ?? result;
      const rows = Array.isArray(payload) ? payload : payload?.rows;

      return (Array.isArray(rows) ? rows : [])
        .map(readTableName)
        .filter((name): name is string => name !== null)
        .slice(0, MAX_TABLES_PER_SOURCE);
    } catch (error) {
      this.logger.warn(
        `[dataSourceInventory] skipping data source ${dataSource?.id} (${dataSource?.kind}) — could not read its schema: ${error?.message}`
      );
      return [];
    }
  }
}
