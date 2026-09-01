import { LldSchema, LldTable, PipelineArtifacts, PipelineStage, StageContext } from './types';

export class LldValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`LLD schema invalid: ${issues.join('; ')}`);
    this.name = 'LldValidationError';
    this.issues = issues;
  }
}

/**
 * Validates an LLD schema against ADR-0028's constraints for this stage: a DB schema
 * with no data seeding. Collects every issue rather than throwing on the first one, so
 * a caller (or a test) sees the full picture in one pass.
 *
 * Deliberately rejects any `seed_data`/`rows`/`data` key on a table object — LLD
 * excludes seeding by design (ADR-0028: "no data seeding"; seeding stays server-side,
 * see `seedPostgresDatasource`/`seedMongoDatasource`), so a model that ignores the
 * instruction and emits rows anyway must fail validation, not silently pass them through.
 */
export function validateLldSchema(schema: LldSchema): string[] {
  const issues: string[] = [];
  const seenTableNames = new Set<string>();

  if (!schema.tables || schema.tables.length === 0) {
    issues.push('schema has no tables');
    return issues;
  }

  for (const table of schema.tables) {
    if (!table.table_name) {
      issues.push('a table is missing table_name');
      continue;
    }
    if (seenTableNames.has(table.table_name)) {
      issues.push(`duplicate table_name "${table.table_name}"`);
    }
    seenTableNames.add(table.table_name);

    const seedKeys = ['seed_data', 'rows', 'data'].filter(
      (key) => key in (table as unknown as Record<string, unknown>)
    );
    if (seedKeys.length > 0) {
      issues.push(`table "${table.table_name}" carries seed data (${seedKeys.join(', ')}) — LLD is schema-only`);
    }

    if (!table.columns || table.columns.length === 0) {
      issues.push(`table "${table.table_name}" has no columns`);
      continue;
    }

    const hasPrimaryKey = table.columns.some((column) => column.constraints_type?.is_primary_key);
    if (!hasPrimaryKey) {
      issues.push(`table "${table.table_name}" has no primary key column`);
    }

    for (const fk of table.foreign_keys ?? []) {
      if (!fk.references_table) {
        issues.push(`table "${table.table_name}" has a foreign key with no references_table`);
      }
    }
  }

  return issues;
}

/** Parses and validates a raw (LLM-produced) LLD payload, throwing on any issue. */
export function parseLldSchema(raw: unknown): LldSchema {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { tables?: unknown }).tables)) {
    throw new LldValidationError(['payload is not an { tables: [...] } object']);
  }

  const schema = raw as LldSchema;
  const issues = validateLldSchema(schema);
  if (issues.length > 0) {
    throw new LldValidationError(issues);
  }

  return schema;
}

/**
 * Topologically orders tables by foreign-key dependency (a table with a foreign key to
 * another comes after it), for the feature-planner stage to consume. Exported here
 * (rather than duplicated in feature-planner.ts) since it's a property of the schema
 * itself, not of planning. Throws on a foreign-key cycle — that's an invalid schema, not
 * a planning decision.
 */
export function topologicallyOrderTables(schema: LldSchema): LldTable[] {
  const byName = new Map(schema.tables.map((table) => [table.table_name, table]));
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  const ordered: LldTable[] = [];

  function visit(table: LldTable) {
    if (visited.has(table.table_name)) return;
    if (inProgress.has(table.table_name)) {
      throw new LldValidationError([`foreign-key cycle detected at table "${table.table_name}"`]);
    }
    inProgress.add(table.table_name);

    for (const fk of table.foreign_keys ?? []) {
      const dependency = byName.get(fk.references_table);
      if (dependency) visit(dependency);
    }

    inProgress.delete(table.table_name);
    visited.add(table.table_name);
    ordered.push(table);
  }

  for (const table of schema.tables) visit(table);
  return ordered;
}

export interface LldStageDeps {
  generateLld(prd: string, ctx: StageContext): Promise<unknown>;
}

/**
 * LLD stage (ADR-0028's third stage) — new, no fork precedent to port. Produces a DB
 * schema (TooljetDB `create_table` shape) with no seeding, enforced by
 * `validateLldSchema`.
 *
 * TODO(#92): the LLD prompt is expected to ground column data types against the
 * component/event catalogs (ADR-0033) so generated schemas stay renderable by the
 * fork's widget set — not wired up, no LLD prompt exists in `prompts/` yet.
 * TODO(#93): `prompts/lld.ts` is currently a placeholder stub (per #93's known gap #3
 * — only PRD had real prior-art to port).
 */
export function buildLldStage(deps: LldStageDeps): PipelineStage {
  return {
    name: 'lld',
    async run(artifacts: PipelineArtifacts, ctx: StageContext): Promise<PipelineArtifacts> {
      const raw = await deps.generateLld(artifacts.prd ?? artifacts.prompt, ctx);
      const lld = parseLldSchema(raw);
      return { ...artifacts, lld };
    },
  };
}
