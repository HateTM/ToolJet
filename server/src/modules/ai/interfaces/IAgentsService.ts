import { StepType } from '@entities/step.entity';

// Per-query outcome of a seed (ticket #62): one report entry per attempted row, so the run
// UI can show exactly which seed rows landed and which failed with what error.
export interface SeedTableReport {
  total: number;
  inserted: number;
  updated: number;
  failed: number;
  failures: Array<{ row: number; error: string }>;
}

export interface IAgentsService {
  CreateTable(organizationId: string, tables: any): Promise<any>;

  // Ticket #77 / ADR-0042: creates a table in a connected PostgreSQL data source instead of
  // ToolJet DB. Only reached after the plan-time collision check and the execution-time
  // confirmation gate have both passed.
  CreateExternalTable(
    organizationId: string,
    dataSourceId: string,
    tableParams: any
  ): Promise<{ id: string; table_name: string }>;

  // Ticket #77 / ADR-0042: the external-target analogue of SeedTable — same per-row report
  // shape, reused verbatim.
  SeedExternalTable(
    organizationId: string,
    dataSourceId: string,
    tableName: string,
    rows: Record<string, any>[]
  ): Promise<SeedTableReport>;

  // Inserts planner-proposed seed rows into an already-created ToolJet DB table
  // (ticket #48). Each row runs as its own query and gets its own report entry
  // (ticket #62); a failed row does not abort the others. Throws only when every
  // row failed.
  SeedTable(
    organizationId: string,
    tableId: string,
    primaryKeyColumns: string[],
    rows: Record<string, any>[]
  ): Promise<SeedTableReport>;

  // `type` + `props` per ADR-0002's generic "CreateComponent(type, props)" tool; the
  // props shape is type-specific (see AgentsService.CreateComponent's doc comment).
  CreateComponent(appVersionId: string, organizationId: string, type: string, props: any): Promise<any>;

  // Merges a sparse { properties?, styles? } patch onto an existing component (ticket #66) —
  // only the paths that changed, validated against componentsMeta the same way
  // CreateComponent's widgets are. Throws when componentId doesn't resolve to a real
  // component rather than creating one.
  UpdateComponent(appVersionId: string, organizationId: string, componentId: string, patch: any): Promise<any>;

  CreateQuery(appVersionId: string, organizationId: string, props: any): Promise<any>;

  // Diff-merges an LLM-proposed options patch into an existing data query's options
  // (ticket #67). The merge itself lives in service.ts's executeUpdateQueryStep (which
  // validates the result); this only persists it.
  UpdateQuery(queryId: string, options: any): Promise<any>;

  // The component inventory of a version, grouped by page id — the grounding an event step
  // needs to resolve target component names to ids (ticket #67).
  ListComponents(appVersionId: string): Promise<Record<string, Record<string, any>>>;

  // Thin persistence wrappers over EventsService for the GenerateEvent step (ticket #67);
  // no policy of their own.
  FindEventsBySource(sourceId: string): Promise<any[]>;
  CreateEvent(appVersionId: string, eventHandler: any): Promise<any>;
  UpdateEventBody(appVersionId: string, eventId: string, event: any): Promise<any>;
  DeleteEvent(appVersionId: string, eventId: string): Promise<any>;

  // Reverts a Step's Artifact (ADR-0008): the inverse of CreateTable/CreateComponent/
  // CreateQuery, dispatched on the same StepType the Artifact was created under.
  undoArtifact(stepType: StepType, appVersionId: string, organizationId: string, content: any): Promise<void>;

  docs(prompt: string, organizationId: string, previousMessages?: any[]): Promise<any>;

  create_header_component(appTitle: string): Promise<any>;

  classify(prompt: string, organizationId: string): Promise<any>;
}
