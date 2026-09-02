import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { Response } from "express";
import { tool } from "ai";
import { z } from "zod";
import { IAiService } from "./interfaces/IService";
import { AiUtilService } from "./util.service";
import { AgentsService } from "./services/agents.service";
import { SeedTableReport } from "./interfaces/IAgentsService";
import {
  UPDATE_QUERY_SYSTEM_PROMPT,
  updateQueryTool,
  mergeQueryUpdate,
  validateMergedQueryOptions,
} from "./services/query-update";
import { isSingleReadOnlyStatement } from "./services/query-security";
import {
  diffTableColumns,
  validateDesiredColumns,
  CurrentTjdbColumn,
  DesiredTjdbColumn,
} from "./services/update-table-diff";
import {
  renderEventCatalogForPrompt,
  normalizeEventId,
  validateEventBody,
} from "./services/event-catalog";
import { AiConversationRepository } from "./repositories/ai-conversation.repository";
import { AiConversationMessageRepository } from "./repositories/ai-conversation-message.repository";
import { ArtifactRepository } from "./repositories/artifact.repository";
import { StepRepository } from "./repositories/step.repository";
import { AiResponseVoteRepository } from "./repositories/ai-response-vote.repository";
import { AppInventoryService } from "./services/app-inventory.service";
import {
  DataSourceInventoryService,
  QueryableDataSource,
  renderConnectedDataSources,
} from "./services/data-source-inventory.service";
import { AiActiveRunService } from "./services/ai-active-run.service";
import { generateQuery as generateQueryPrompts } from "./prompt-library";
import { AiFeasibilityService } from "./services/ai-feasibility.service";
import { GenerationEngineClient } from "./services/generation-engine-client";
import { VersionRepository } from "@modules/versions/repository";
import { Step, StepType } from "@entities/step.entity";
import { Artifact } from "@entities/artifact.entity";
import { AiConversation } from "@entities/ai_conversation.entity";
import { AiConversationMessage } from "@entities/ai_conversation_message.entity";
import { Completion, CopilotContext, ErrorContext, Suggestion } from "./types";
import { User } from "@entities/user.entity";
import { UserPermissions } from "@modules/ability/types";

const CONVERSATION_TYPES = ["generate", "learn"] as const;
type ConversationType = (typeof CONVERSATION_TYPES)[number];

// Grounds the assistant in the Generate-conversation contract (see CONTEXT.md's
// "PRD" entry and ADR-0001): a Generate conversation only ever proposes a PRD in
// chat — it must never claim to have changed the App, since nothing is built
// until the user approves it (a later ticket). v1 target types per ADR-0002.
const PRD_SYSTEM_PROMPT = `You are the AI Builder assistant for ToolJet, a low-code app platform.

Your job in this conversation is to help the user turn their app idea into a clear Product Requirements Document (PRD): a structured description of the app to build — its pages, and for each page the components (Page, Table, Form, Button, Text, TextInput, Container, Chart, Image, Checkbox, Dropdown, Modal) and any data queries it needs.

Ask clarifying questions if the request is ambiguous or underspecified. Once you have enough detail, respond with a structured PRD covering the app's purpose, its pages, and the components/queries each page needs. The user can keep refining the PRD by chatting further — nothing is built until they explicitly approve it.`;

// Grounds a Learn conversation (CONTEXT.md's "Learn conversation"): it answers questions
// about the App from the freshly-assembled App inventory it's given, and it never builds.
// The "point at Promote" instruction is what keeps a build request inside a Learn thread from
// turning into an implicit escalation — ADR-0012 makes starting a Generate conversation an
// explicit user action, so the assistant's only correct move is to say so.
const LEARN_SYSTEM_PROMPT = `You are the AI Builder assistant for ToolJet, a low-code app platform, answering questions about one specific app the user has open.

Answer strictly from the app inventory below — the app's pages, the components on each page, its data sources, its queries, and the summaries of what has already been built into it. It is a complete snapshot of the app's structure, so if something is not in it, it does not exist in this app; say so plainly rather than guessing. The inventory deliberately omits layout and styling details, so questions about exact positions, sizes, or colors can't be answered from it.

You cannot change this app in this conversation — you have no ability to create, edit, or delete pages, components, queries, or tables here. If the user asks you to build or change something, do not attempt it and do not claim you have: tell them to use the "Start building" action on your answer, which opens a new build conversation carrying this question and answer over as context.`;

// v1 step vocabulary (ADR-0002). The planner is free to propose any of these — see
// ADR-0006 — even though only CreateTable has a real handler in this ticket. Ticket #67
// extends the vocabulary with the two edit steps: a diff-merge into an existing query's
// options and event wiring on components/queries the plan has created; ticket #66 adds
// the UpdateComponent diff-patch edit step.
const STEP_TYPES = [
  "CreateTable",
  "UpdateTable",
  "CreateQuery",
  "CreateComponent",
  "UpdateComponent",
  "DeleteComponent",
  "MoveComponent",
  "UpdateQuery",
  "DeleteQuery",
  "GenerateEvent",
] as const;

export const STEP_PLAN_SYSTEM_PROMPT = `You turn an approved Product Requirements Document (PRD) into an ordered build plan for a ToolJet app.

Call proposeStepPlan exactly once with the ordered list of steps needed to build what the PRD describes. Each step is one of:
- CreateTable: creates a table. By default this creates a ToolJet DB table. If the PRD explicitly asks for the table to live in a connected PostgreSQL source (see the connected data sources below), set the optional data_source_id field to that source's id — every other connector kind never accepts a CreateTable step, only postgresql. Include the full table definition you propose in the optional table field — the user previews exactly that definition (tables, columns, foreign keys, indexes) before approving, and it is what gets created. A table name that already exists in the target source fails this step at plan time — pick a name you have not been shown as already existing there.
  If the PRD asks for sample or starting data, also propose it in the optional seed_rows field: rows consistent with the table's columns, omitting auto-generated (serial) primary key columns. The user previews the exact rows before approving, and they are inserted into the table as part of this step. Never invent seed rows the PRD does not call for.
- CreateQuery: creates a data query, either against a ToolJet DB table or against a data source the user has already connected.
- CreateComponent: creates a UI element (a page or a widget on a page).
- UpdateComponent: changes a component that already exists in this app (its text, a property, or a style) — never a component this same plan is about to create with CreateComponent (give that component its final properties directly instead). Reference the target by the id/name given in "Existing components already in this app" below; never invent one. Use this only when the PRD is asking to edit something that's already there.
- DeleteComponent: removes a component that already exists in this app. Reference it by the id/name given in "Existing components already in this app" below; never invent one, and never target a component this same plan is about to create.
- MoveComponent: reparents a component that already exists in this app into a different Container, Form or Listview (or back to the page root). Reference both by the id/name given in "Existing components already in this app" below; never invent one, never target a component this same plan is about to create, and never move into a ModalV2 or Tabs (not supported by this step — nest into those at create time with CreateComponent's parentComponentId instead).
- UpdateQuery: changes an existing query the plan (or an earlier step) created — e.g. different columns, a filter, a limit. The model at execution time returns only the option keys that change; nothing else on the query is touched. Use this instead of a second CreateQuery for the same table.
- DeleteQuery: removes a query this same plan created earlier — never a query outside this plan.
- GenerateEvent: wires one event on a component or query the plan has already created (e.g. "the button opens the modal" is a GenerateEvent on the Button, not a new component). It never creates components or queries itself.


Order matters: a table must exist before a query reads from it, and a query before a component that uses it. Give each step a short, specific description of what it builds.

Also group the steps into a small number of named phases (ticket #21) — e.g. "Create data tables", "Create data queries", "Build the interface". Set each step's phase to a short human-readable phase name; consecutive steps that belong to the same phase must repeat the exact same phase string. Use between 1 and 4 phases, in execution order.`;

// ToolJet DB's supported column types (server/src/modules/tooljet-db/types.ts's TJDB map).
const TJDB_DATA_TYPES = [
  "character varying",
  "integer",
  "bigint",
  "serial",
  "double precision",
  "boolean",
  "timestamp with time zone",
  "jsonb",
] as const;

export const TJDB_FOREIGN_KEY_ACTIONS = [
  "RESTRICT",
  "NO ACTION",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
] as const;

// The full definition of one ToolJet DB table, shared by the planner (which proposes it at
// plan time so it can be previewed before approval, ticket #20) and the per-step createTable
// tool (which historically was the only place a table's schema existed, at execution time).
const tableDefinitionObject = z.object({
  table_name: z
    .string()
    .describe("snake_case table name, unique within this app"),
  columns: z
    .array(
      z.object({
        column_name: z.string(),
        data_type: z.enum(TJDB_DATA_TYPES),
        is_primary_key: z.boolean(),
        is_not_null: z.boolean(),
        is_unique: z.boolean(),
      }),
    )
    .min(1)
    .describe("Exactly one column must have is_primary_key: true"),
  foreign_keys: z
    .array(
      z.object({
        // One or more columns in this table that must reference a column (or columns)
        // in another table in this app.
        column_names: z
          .array(z.string())
          .min(1)
          .describe("Column(s) in this table that are referenced"),
        referenced_table_name: z
          .string()
          .describe(
            "Name of another table in this app that these columns reference",
          ),
        referenced_column_names: z
          .array(z.string())
          .min(1)
          .describe(
            "Column(s) in referenced_table_name that these columns reference",
          ),
        on_delete: z
          .enum(TJDB_FOREIGN_KEY_ACTIONS)
          .describe(
            "Action when a referenced row is deleted; one of 'RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'",
          )
          .optional(),
        on_update: z
          .enum(TJDB_FOREIGN_KEY_ACTIONS)
          .describe(
            "Action when a referenced row is updated; one of 'RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'",
          )
          .optional(),
      }),
    )
    .optional()
    .describe(
      "Relationships to other tables in this app. Omit this field to create a table with no foreign keys. " +
        "Referenced tables must already exist in this app.",
    ),
  indexes: z
    .array(
      z.object({
        column_names: z
          .array(z.string())
          .min(1)
          .describe("Column(s) in this table to index"),
        is_unique: z
          .boolean()
          .optional()
          .describe(
            "Set true only when uniqueness must be enforced by the index",
          ),
      }),
    )
    .optional()
    .describe(
      "Indexes to create on this table for query performance (ticket #23). Omit when the table is small " +
        "or every column already benefits from an existing constraint. Index foreign-key columns and " +
        "columns frequently filtered or sorted on.",
    ),
});

type TableDefinition = z.infer<typeof tableDefinitionObject>;

// One seed row the planner proposes for a table it also proposes (ticket #48): a plain
// record of column name → primitive value. Structured rows, not SQL — the same principle
// ADR-0020 set for the table definition itself, so the preview renders the data (not a
// query) and execution inserts exactly what was previewed, with no SQL surface anywhere.
const seedRowObject = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

const seedRowsObject = z
  .array(seedRowObject)
  .min(1)
  .max(50)
  .describe(
    "Seed rows to insert after this table is created. Only when the PRD asks for sample/starting data. " +
      "Each row maps column names to values and must be consistent with the columns defined above; " +
      "omit auto-generated (serial) primary key columns.",
  );

// A planned seed-rows array is trusted verbatim only when every row is a plain, non-empty
// object of primitive-or-null values — anything looser is dropped at plan time rather than
// half-executed (same policy as isWellFormedTableDefinition).
const isWellFormedSeedRows = (rows: any): rows is Record<string, any>[] =>
  Array.isArray(rows) &&
  rows.length > 0 &&
  rows.length <= 50 &&
  rows.every(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).length > 0 &&
      Object.values(row).every(
        (value) =>
          value === null ||
          ["string", "number", "boolean"].includes(typeof value),
      ),
  );

// A planned table is trusted verbatim only when it could actually create a table: a real
// (non-blank) name and at least one column with a name and a type. Anything looser falls
// back to the per-step LLM path rather than failing execution on a malformed contract.
// Seed rows are only as good as their fit to the table they seed: every key must be a real
// column of the planned table (ticket #48). Column order and completeness are not required —
// a serial primary key may be omitted — but an unknown column would fail at insert time.
const areSeedRowsConsistentWithTable = (
  rows: Record<string, any>[],
  table: TableDefinition,
): boolean => {
  const columnNames = new Set(
    table.columns.map((column) => column.column_name),
  );
  return rows.every((row) =>
    Object.keys(row).every((key) => columnNames.has(key)),
  );
};

const isWellFormedTableDefinition = (table: any): table is TableDefinition =>
  Boolean(
    table &&
    typeof table.table_name === "string" &&
    table.table_name.trim() &&
    Array.isArray(table.columns) &&
    table.columns.length > 0 &&
    table.columns.every(
      (column: any) =>
        column &&
        typeof column.column_name === "string" &&
        column.column_name.trim() &&
        typeof column.data_type === "string",
    ),
  );

// Ticket #77 / ADR-0042: what a proposed CreateTable step's `data_source_id` resolves to,
// decided once at plan time — never re-decided at execution. Exported as a pure function
// (no I/O) so the three outcomes are each directly unit-testable without mocking the LLM
// gateway or a repository: 'tjdb' whenever no id was given, the id names a source not shown
// to the planner, or that source's kind isn't 'postgresql' (ADR-0018 stands unchanged for
// every other kind); 'collision' when the proposed table name already exists in that source
// (`dataSources[].tables`, from the same listTables introspection ADR-0019 already runs, per
// ticket #77's implementation note — no second call); 'external' otherwise.
export type CreateTableTargetResolution =
  | { kind: "tjdb" }
  | { kind: "external"; dataSource: QueryableDataSource }
  | { kind: "collision"; dataSource: QueryableDataSource; message: string };

export const resolveCreateTableTarget = (
  dataSourceId: string | undefined,
  tableName: string | undefined,
  dataSources: QueryableDataSource[],
): CreateTableTargetResolution => {
  if (!dataSourceId) return { kind: "tjdb" };
  const target = dataSources.find((source) => source.id === dataSourceId);
  if (!target || target.kind !== "postgresql") return { kind: "tjdb" };
  if (tableName && target.tables.includes(tableName)) {
    return {
      kind: "collision",
      dataSource: target,
      message:
        `A table named "${tableName}" already exists in the connected PostgreSQL source ` +
        `"${target.name}". CreateTable never alters or reuses an existing table, so this ` +
        `step cannot be built — pick a different table name, or target ToolJet DB instead.`,
    };
  }
  return { kind: "external", dataSource: target };
};

export const proposeStepPlanTool = tool({
  description: "Propose the ordered list of build steps for this PRD.",
  parameters: z.object({
    steps: z
      .array(
        z.object({
          type: z.enum(STEP_TYPES),
          description: z
            .string()
            .describe("Short, specific description of what this step builds"),
          // Only meaningful on CreateTable steps: the concrete table definition this step
          // proposes, persisted as the Step's plannedTable and shown in the pre-approval
          // schema preview (ticket #20).
          table: tableDefinitionObject.optional(),
          // Only meaningful on CreateTable steps (ticket #77 / ADR-0042): the id of a
          // connected data source (from the connected-sources block) this step targets
          // instead of ToolJet DB. Only honored when that source's kind is 'postgresql' —
          // every other kind falls back to ToolJet DB unchanged (ADR-0018).
          data_source_id: z.string().optional(),
          // Only meaningful on CreateTable steps: the seed rows this step proposes to insert
          // after the table is created (ticket #48), persisted as the Step's plannedSeedRows
          // and shown in the pre-approval schema preview alongside the table.
          seed_rows: seedRowsObject.optional(),
          // The named phase this step belongs to (ticket #21). Optional so an older planner
          // response without one still validates — a missing phase falls back to a single
          // derived group on the client.
          phase: z
            .string()
            .optional()
            .describe("Short human-readable phase name this step belongs to"),
        }),
      )
      .min(1),
  }),
});

export const CREATE_TABLE_SYSTEM_PROMPT = `You design the exact schema for one ToolJet DB table, based on the PRD and the specific step you've been asked to build.

Call createTable exactly once with the table's real name (snake_case) and its columns. Every table needs exactly one primary key column (usually an auto-generated "id" of type serial). Pick sensible, minimal columns that satisfy what this step describes — don't invent columns the PRD doesn't call for.

If this table's rows must always reference rows in another table in this app (for example a "customer_id" that must exist in the "customers" table), declare that relationship with the optional foreign_keys field: list the column(s) in this table, the referenced table, and the referenced column(s); optionally set on_delete/on_update to one of 'RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'. Only reference tables that already exist in this app — the referenced table's columns must match the column names you list. Omit foreign_keys when no such relationship is needed.

Use the optional indexes field when a table will be filtered, sorted, or joined on columns beyond the primary key — most commonly the columns that foreign keys point from. Each index lists the column(s) to index; set is_unique only when uniqueness must be enforced. Don't index a column that is already the table's primary key, and omit indexes when they wouldn't help.`;

export const createTableTool = tool({
  description: "Create a ToolJet DB table with the given name and columns.",
  parameters: tableDefinitionObject,
});

// Ticket #111 / ADR-0041: update_table is a full replace of the table's column definition
// (same shape as createTable, plus an optional explicit renames map so a rename keeps the
// column's data instead of inferring drop+add). The engine diffs this payload against the
// table's real current schema — the LLM is never trusted to know the current schema.
export const UPDATE_TABLE_SYSTEM_PROMPT = `You update the schema of one existing ToolJet DB table, based on the PRD and the specific step you've been asked to build.

Call updateTable exactly once with the table's exact current name and the COMPLETE list of columns the table should have after this step. This is a full replace, not a patch: every column that should survive — existing or new — must appear in your columns list, described in the same shape the createTable tool uses (column_name, data_type, is_primary_key, is_not_null, is_unique). The engine compares your list against the table's real current schema and applies exactly the difference; an unchanged table means an empty diff, so never invent changes to seem useful.

Rules:
- Keep exactly one primary key column. Dropping or swapping the table's primary key is not allowed.
- You are shown the table's current columns. Any current column you omit from your list will be DROPPED, and its data is lost — omit a column only when the step genuinely calls for removing it. Dropping a column that is part of a foreign key is refused outright.
- When an existing column keeps its meaning but should be called something else, say so with the optional renames map ("old_column_name": "new_column_name") instead of dropping and re-adding it: a rename keeps the column's data, a drop loses it.
- New columns you add must satisfy what this step describes — pick sensible, minimal defaults consistent with the rest of the table.
- Changing a column's type or constraints (is_not_null, is_unique) is expressed by listing the column with its new attributes; the engine applies the alter.
- Foreign keys and indexes are not part of this update: leave them as they are.`;

export const updateTableTool = tool({
  description:
    "Replace an existing ToolJet DB table's column definition with the complete desired column list.",
  parameters: tableDefinitionObject.extend({
    renames: z
      .record(z.string())
      .optional()
      .describe(
        "Explicit old_column_name -> new_column_name renames. A renamed column keeps its data; omitting it from columns instead drops it and loses the data. A rename's old name must be a current column and must not also appear in columns.",
      ),
  }),
});

// The full allow-list (ADR-0002's v1 set — Page, Table, Form, Button, Text, TextInput,
// Container — extended per ticket #13 with Chart, Image, Checkbox, Dropdown, Modal).
// Unlike an unsupported *Step* type (ADR-0006, which can never
// succeed since no handler exists), an unsupported *component* type is retried: the model
// picks it per attempt, so a later retry can self-correct to a supported one.
const SUPPORTED_COMPONENT_TYPES = [
  "Page",
  "Table",
  "Button",
  "Text",
  "TextInput",
  "Container",
  "Form",
  "Chart",
  "Image",
  "Checkbox",
  "Dropdown",
  "Modal",
  // Wave 1 (plan increment 3) — simple widgets, ported from the full platform catalog.
  "TextArea",
  "PasswordInput",
  "NumberInput",
  "EmailInput",
  "Link",
  "Divider",
  "Icon",
  "StarRating",
  "Statistics",
  "Tags",
  "CurrencyInput",
  "PhoneInput",
  "Datepicker",
  // Wave 2 (plan increment 3) — more complex widgets. Placed standalone/empty, same as
  // Container/Modal above: nesting children into them isn't wired up yet (increment 4),
  // except ModalV2 — its body/header/footer slots accept parentComponentId (increment 4
  // follow-up, see executeComponentStep's parentComponentId validation below).
  "Tabs",
  "Listview",
  "IFrame",
  "FilePicker",
  "ModalV2",
  "TreeSelect",
  "Html",
  "PopoverMenu",
  "ButtonGroupV2",
  "DatePickerV2",
  "Chat",
] as const;

// Component types that place a widget on an existing Page — everything except 'Page'
// itself (which creates one). Used to validate `pageId` uniformly across all of them.
const PAGE_WIDGET_TYPES = SUPPORTED_COMPONENT_TYPES.filter(
  (type) => type !== "Page",
);

const CREATE_COMPONENT_SYSTEM_PROMPT = `You create one UI element for this step, based on the PRD and whatever earlier steps in this plan already created (listed below, if any).

Call createComponent exactly once. Supported component types: Page, Table, Button, Text, TextInput, Container, Form, Chart, Image, Checkbox, Dropdown, Modal.
- Page: give it a short, specific name.
- Table: reference the id of a Page already created in this plan to place it on, give it a title, and reference the name of a query already created in this plan whose data it should display.
- Button: reference a Page id, give it a short label.
- Text: reference a Page id, give it the text to display.
- TextInput: reference a Page id, give it a label (and an optional placeholder).
- Container: reference a Page id, give it a short title. Other widgets can nest inside it — see parentComponentId below.
- Form: reference a Page id, the id of a ToolJet DB table already created in this plan, and a form title. By default (mode "create") this produces a working create-record form — you don't need a separate query or event step for it. When the PRD wants to edit existing records, set mode "edit" and also reference the name of a Table widget already created in this plan that is bound to the same underlying table — the form's fields then pre-fill from that Table's selected row and submitting runs an update keyed on that row. Other widgets can also nest inside it — see parentComponentId below.
- Chart: reference a Page id, give it a title, and optionally reference the name of a query already created in this plan whose data it should plot (omit queryName to get an empty chart). Pick a chartType from "line", "bar", "pie" (default "line").
- Image: reference a Page id and give the image's source URL (and an optional alt text).
- Checkbox: reference a Page id, give it a label, and optionally set defaultChecked.
- Dropdown: reference a Page id, give it a label, and provide its options as a list of short strings (optionally a placeholder).
- Modal: reference a Page id, give it a title; it renders with a default trigger button (optionally set the trigger button label). Place Modal's content as separate sibling widgets on the page — widgets cannot be nested inside it.
- TextArea: reference a Page id, give it a label (optional placeholder and default value).
- PasswordInput: reference a Page id, give it a label (optional placeholder).
- NumberInput: reference a Page id, give it a label (optional placeholder and default numeric value).
- EmailInput: reference a Page id, give it a label (optional placeholder).
- Link: reference a Page id, give it the link text and the target URL (optionally openInNewTab, default true).
- Divider: reference a Page id (optional label shown on the divider).
- Icon: reference a Page id and a Tabler icon name (e.g. "IconHome2").
- StarRating: reference a Page id, give it a label, and optionally maxRating (default 5) and defaultSelected.
- Statistics: reference a Page id, give it a primary label and value, and optionally a secondary label and value.
- Tags: reference a Page id and optionally a list of short tag strings (default demo tags when omitted).
- CurrencyInput: reference a Page id, give it a label (optional placeholder and default numeric value).
- PhoneInput: reference a Page id, give it a label (optional placeholder).
- Datepicker: reference a Page id (optional default value, placeholder, and format, e.g. "DD/MM/YYYY").
- Tabs: reference a Page id (optional list of tab titles, default 3 stock tabs). Only one Tabs per page. Other widgets can nest into a specific pane — see parentComponentId below.
- Listview: reference a Page id, and optionally the name of a query already created in this plan whose rows it should list (omit for stock demo rows). Other widgets can nest into its single row template — see parentComponentId below.
- IFrame: reference a Page id and the URL to embed.
- FilePicker: reference a Page id (optional label). Upload UI only — files are not wired to any query yet.
- ModalV2: reference a Page id (optional trigger button label); it renders with a default trigger button. Other widgets can nest into its body, header, or footer — see parentComponentId below.
- TreeSelect: reference a Page id (optional label). Keeps its own stock demo tree — a real hierarchy from arbitrary data isn't supported yet.
- Html: reference a Page id and raw HTML to render.
- PopoverMenu: reference a Page id, give it a label, and optionally a list of short option strings (default 3 stock options).
- ButtonGroupV2: reference a Page id, give it a label, and optionally a list of short button labels (default 3 stock buttons).
- DatePickerV2: reference a Page id, give it a label (optional default value, placeholder, and format).
- Chat (EXPERIMENTAL — decorative only): reference a Page id (optional chat title). No query or event is wired to actually send/receive messages; use only when the PRD explicitly wants a chat UI mockup, not a working chat feature.
Any widget type (except Page itself) accepts an optional parentComponentId: the id of a Container, Form or Listview already created in this plan on the same page, to nest this widget inside it instead of placing it directly on the page. A Listview has a single row template shared by every row it renders — you cannot address individual rows, so a widget nested there must bind its data-bearing property to {{listItem.<key>}} (using a key from the query the Listview displays), never a static value, or every rendered row will show identical content. For a ModalV2 already created in this plan, use its id for the body slot, "<modalId>-header" for the header slot, or "<modalId>-footer" for the footer slot — keep header/footer children small (a label, a button, an icon), they render in a thin strip. For a Tabs already created in this plan, use "<tabsId>-<tabIndex>" (0-based — the first tab is index 0, whether or not you gave tabs custom titles) to nest into that specific pane; a bare Tabs id is not valid on its own.
Only reference pages/tables/queries that actually appear in the context below — never invent an id or name.`;

const createComponentTool = tool({
  description:
    "Create a Page, or a widget (Table, Button, Text, TextInput, Container, Form, Chart, Image, Checkbox, Dropdown, Modal, TextArea, PasswordInput, NumberInput, EmailInput, Link, Divider, Icon, StarRating, Statistics, Tags, CurrencyInput, PhoneInput, Datepicker, Tabs, Listview, IFrame, FilePicker, ModalV2, TreeSelect, Html, PopoverMenu, ButtonGroupV2, DatePickerV2, Chat) on an existing Page.",
  parameters: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("Page"),
      name: z.string().describe('Short page title, e.g. "Orders"'),
    }),
    z.object({
      type: z.literal("Table"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this table on",
        ),
      title: z.string().describe("Table title shown in the UI"),
      queryName: z
        .string()
        .describe(
          "name of an already-created query (from context) this table should display",
        ),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Button"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this button on",
        ),
      text: z.string().describe("Button label text"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Text"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this text on",
        ),
      text: z.string().describe("Text content to display"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("TextInput"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this input on",
        ),
      label: z.string().describe("Input label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Container"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this container on",
        ),
      title: z.string().describe("Short container title"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Form"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this form on",
        ),
      tableId: z
        .string()
        .describe(
          "id of an already-created ToolJet DB table (from context) this form creates records in or edits records in",
        ),
      title: z.string().describe("Form title"),
      mode: z
        .enum(["create", "edit"])
        .default("create")
        .describe(
          "'create' (default) wires a create_row query to submit; 'edit' wires an update_rows query keyed on the referenced Table's selectedRow and pre-fills the fields from it",
        ),
      tableName: z
        .string()
        .optional()
        .describe(
          "name of an already-created Table widget (from context) whose selectedRow this form binds to — required when mode='edit'",
        ),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Chart"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this chart on",
        ),
      title: z.string().describe("Chart title shown in the UI"),
      queryName: z
        .string()
        .optional()
        .describe(
          "name of an already-created query (from context) whose data this chart should plot",
        ),
      chartType: z
        .enum(["line", "bar", "pie"])
        .default("line")
        .describe("Chart rendering style; default 'line'"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Image"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this image on",
        ),
      source: z.string().describe("Image source URL"),
      alternativeText: z.string().optional().describe("Alt text for the image"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Checkbox"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this checkbox on",
        ),
      label: z.string().describe("Checkbox label"),
      defaultChecked: z
        .boolean()
        .optional()
        .describe("Whether the checkbox starts checked (default false)"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Dropdown"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this dropdown on",
        ),
      label: z.string().describe("Dropdown label"),
      options: z
        .array(z.string())
        .min(1)
        .describe("The choices to offer, as short strings, in display order"),
      placeholder: z
        .string()
        .optional()
        .describe("Placeholder shown before a choice is made"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Modal"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this modal on",
        ),
      title: z.string().describe("Modal title shown in its title bar"),
      triggerButtonLabel: z
        .string()
        .optional()
        .describe("Label of the default trigger button that opens the modal"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("TextArea"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this textarea on",
        ),
      label: z.string().describe("Textarea label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      value: z.string().optional().describe("Default value"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("PasswordInput"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this password input on",
        ),
      label: z.string().describe("Input label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("NumberInput"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this number input on",
        ),
      label: z.string().describe("Input label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      defaultValue: z.number().optional().describe("Default numeric value"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("EmailInput"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this email input on",
        ),
      label: z.string().describe("Input label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Link"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this link on",
        ),
      text: z.string().describe("Link text"),
      url: z.string().describe("Link target URL"),
      openInNewTab: z
        .boolean()
        .optional()
        .describe("Whether the link opens in a new tab (default true)"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Divider"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this divider on",
        ),
      label: z
        .string()
        .optional()
        .describe("Optional label shown on the divider"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Icon"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this icon on",
        ),
      icon: z.string().describe('Tabler icon name, e.g. "IconHome2"'),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("StarRating"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this rating on",
        ),
      label: z.string().describe("Rating label"),
      maxRating: z.number().optional().describe("Number of stars (default 5)"),
      defaultSelected: z
        .number()
        .optional()
        .describe("Number of stars selected by default"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Statistics"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this stat tile on",
        ),
      primaryLabel: z.string().describe("Primary value's label"),
      primaryValue: z
        .union([z.string(), z.number()])
        .describe("Primary value to display"),
      secondaryLabel: z.string().optional().describe("Secondary value's label"),
      secondaryValue: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Secondary value to display"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Tags"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place these tags on",
        ),
      tags: z
        .array(z.string())
        .optional()
        .describe(
          "Short tag strings to display; omit for a demo set of 4 tags",
        ),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("CurrencyInput"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this currency input on",
        ),
      label: z.string().describe("Input label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      defaultValue: z.number().optional().describe("Default numeric value"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("PhoneInput"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this phone input on",
        ),
      label: z.string().describe("Input label"),
      placeholder: z.string().optional().describe("Placeholder text"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Datepicker"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this date picker on",
        ),
      defaultValue: z
        .string()
        .optional()
        .describe('Default date, matching `format`, e.g. "01/01/2022"'),
      placeholder: z.string().optional().describe("Placeholder text"),
      format: z
        .string()
        .optional()
        .describe('Date format string (default "DD/MM/YYYY")'),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Tabs"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this tab bar on",
        ),
      tabs: z
        .array(z.string())
        .optional()
        .describe("Tab titles, in order; omit for 3 stock tabs"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Listview"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this list on",
        ),
      queryName: z
        .string()
        .optional()
        .describe(
          "name of an already-created query (from context) whose rows this list should display; omit for stock demo rows",
        ),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("IFrame"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this iframe on",
        ),
      source: z.string().describe("URL to embed"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("FilePicker"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this file picker on",
        ),
      label: z.string().optional().describe("Label shown above the picker"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("ModalV2"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this modal on",
        ),
      triggerButtonLabel: z
        .string()
        .optional()
        .describe("Label of the default trigger button that opens the modal"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("TreeSelect"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this tree select on",
        ),
      label: z.string().optional().describe("Field label"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Html"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this HTML block on",
        ),
      html: z.string().describe("Raw HTML to render"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("PopoverMenu"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this menu on",
        ),
      label: z.string().describe("Menu trigger label"),
      options: z
        .array(z.string())
        .optional()
        .describe("Menu option labels, in order; omit for 3 stock options"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("ButtonGroupV2"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this button group on",
        ),
      label: z.string().describe("Button group label"),
      options: z
        .array(z.string())
        .optional()
        .describe("Button labels, in order; omit for 3 stock buttons"),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("DatePickerV2"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this date picker on",
        ),
      label: z.string().describe("Field label"),
      defaultValue: z
        .string()
        .optional()
        .describe('Default date, matching `format`, e.g. "01/01/2022"'),
      placeholder: z.string().optional().describe("Placeholder text"),
      format: z
        .string()
        .optional()
        .describe('Date format string (default "DD/MM/YYYY")'),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
    z.object({
      type: z.literal("Chat"),
      pageId: z
        .string()
        .describe(
          "id of an already-created Page (from context) to place this chat UI on",
        ),
      chatTitle: z
        .string()
        .optional()
        .describe(
          "Chat panel title; experimental — decorative only, no working send/receive",
        ),
      parentComponentId: z
        .string()
        .optional()
        .describe(
          'id of an already-created Container, Form or Listview (from context) to nest this widget inside; for a ModalV2, use its id (body), "<modalId>-header", or "<modalId>-footer"; for a Tabs, use "<tabsId>-<tabIndex>" (0-based, e.g. "<tabsId>-0" for the first tab); omit to place it directly on the page',
        ),
    }),
  ]),
});

// ticket #66 (port of the EE updateComponent/updateSingleComponent idea): the LLM is told to
// return ONLY the paths it is actually changing — never re-emit the whole component — because
// the merge step (AgentsService.UpdateComponent) treats every key it's given as an intentional
// change, and a full re-emission would happily "restore" everything else to whatever the model
// guessed instead of leaving it untouched.
const UPDATE_COMPONENT_SYSTEM_PROMPT = `You change ONE existing component for this step, based on the PRD and the "Existing components already in this app" list below.

Call updateComponent exactly once:
- componentId: the real id of the target component, copied verbatim from the list below. Never invent one, and never target a component this same plan is about to create with CreateComponent.
- properties / styles: include ONLY the paths that actually need to change, as flat { propName: newValue } pairs — e.g. to change a Text widget's text, return { properties: { text: "New title" } } and nothing else. Do not re-list properties/styles that are not changing.
- If the step's instruction doesn't actually require any change, call updateComponent with empty properties and styles ({}) rather than guessing at a change.`;

const updateComponentTool = tool({
  description:
    "Change one or more properties/styles of an existing component, leaving everything else untouched. Return only the paths that changed.",
  parameters: z.object({
    componentId: z
      .string()
      .describe(
        "id of the existing component to change, copied from the 'Existing components already in this app' list",
      ),
    properties: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Only the properties that changed, as { propName: newValue }. Omit or leave empty when nothing here changes.",
      ),
    styles: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Only the styles that changed, as { styleName: newValue }. Omit or leave empty when nothing here changes.",
      ),
  }),
});

// Ticket #4 / increment 4: removes one existing component. Kept deliberately narrow (id
// only, no confirmation text) — the planner already decided this step is a delete when it
// proposed it; re-asking the model to justify it here would just be more ways to hallucinate.
const DELETE_COMPONENT_SYSTEM_PROMPT = `You remove ONE existing component for this step, based on the PRD and the "Existing components already in this app" list below.

Call deleteComponent exactly once with componentId set to the real id of the target component, copied verbatim from the list below. Never invent one, and never target a component this same plan is about to create with CreateComponent.`;

const deleteComponentTool = tool({
  description:
    "Delete one existing component, along with any events attached to it.",
  parameters: z.object({
    componentId: z
      .string()
      .describe(
        "id of the existing component to delete, copied from the 'Existing components already in this app' list",
      ),
  }),
});

// MoveComponent (ADR-0043 follow-up): reparents one existing component. Bare-id targets
// only (Container/Form/Listview body) — ModalV2 header/footer and Tabs panes are create-time
// nesting only in this pass, not a Move target (see ADR-0043's "Follow-up 3").
const MOVE_COMPONENT_SYSTEM_PROMPT = `You reparent ONE existing component for this step, based on the PRD and the "Existing components already in this app" list below.

Call moveComponent exactly once with componentId set to the real id of the component to move, copied verbatim from the list below. Set newParentComponentId to the real id of the Container, Form or Listview to move it into (also copied verbatim), or omit it to move the component back to its page's root — outside any container. Never invent an id, never target a component this same plan is about to create or delete, and never target a ModalV2 or Tabs as the new parent (moving into a specific slot/pane isn't supported by this step).`;

const moveComponentTool = tool({
  description:
    "Reparent one existing component into a different Container, Form or Listview, or back to the page root.",
  parameters: z.object({
    componentId: z
      .string()
      .describe(
        "id of the existing component to move, copied from the 'Existing components already in this app' list",
      ),
    newParentComponentId: z
      .string()
      .optional()
      .describe(
        "id of the existing Container, Form or Listview to move it into, copied from the same list; omit to move it to the page root",
      ),
  }),
});

// Mirrors UpdateQuery's scope on purpose (ADR-0027): only a query this same plan created
// earlier can be targeted, never an arbitrary pre-existing query — deleting something outside
// the plan's own blast radius is a much larger footgun than editing it.
const DELETE_QUERY_SYSTEM_PROMPT = `You remove ONE existing query for this step, based on the PRD and the "Existing queries" list below.

Call deleteQuery exactly once with queryName set to the exact name of the target query, copied verbatim from the list below.`;

const deleteQueryTool = tool({
  description: "Delete one query this plan created earlier.",
  parameters: z.object({
    queryName: z
      .string()
      .describe("name of an already-created query (from this plan) to delete"),
  }),
});

// Opening line sourced from the ported EE prompt library (prompt-library/generateQuery.ts);
// the tool contract below is the fork's own (ADR-0006 v1 vocabulary): the model picks a
// narrow createQuery call, it never writes a full runjs/runpy query config the way EE's
// flow did.
const CREATE_QUERY_SYSTEM_PROMPT = [
  generateQueryPrompts.systemPrompt(),
  `You create one data query for this step, based on the PRD, the table(s) already created earlier in this plan, and the connected data sources listed below (if any).

Call createQuery exactly once with a short snake_case query name (components will reference it as {{queries.<name>.data}}) and the query itself:
- source "tooljetdb" — the default. Give the real id of a ToolJet DB table created earlier in this plan to list rows from.
- source "sql" — only when this step is meant to read from a connected SQL data source the user has already connected. Give that source's real id and one SQL SELECT statement against a table that source actually has.
- source "restapi" — only when this step is meant to call a connected REST API data source the user has already connected. Give that source's real id, the HTTP method, and a request path relative to that source's base URL (e.g. "/users/{{components.userId.value}}"). Headers, query params, and a request body are optional.
- source "plugin" — only when this step is meant to call a connected plugin data source (Slack, Airtable, Google Sheets, and similar) the user has already connected. Give that source's real id, the exact operation value from its "operations" list in the connected data sources below, and any fields that operation needs as key/value pairs — the fields are plugin-specific and not listed here, so infer them from the operation's name and the PRD (e.g. Slack's "send_message" needs a channel and a message).

Every id must come from the context below, never invented. Prefer ToolJet DB unless the PRD or this step clearly asks for data that lives in a connected source.`,
].join("\n\n");

// Discriminated on `source` rather than left as one loose object, for the same reason
// createComponentTool is: the two branches share only a name, and a single flat schema would
// let the model return an SQL string with a ToolJet DB table id, which is unbuildable.
const createQueryTool = tool({
  description:
    "Create a query against an existing ToolJet DB table, or against a connected SQL, REST API, or plugin data source.",
  parameters: z.discriminatedUnion("source", [
    z.object({
      source: z.literal("tooljetdb"),
      name: z
        .string()
        .describe(
          "snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}",
        ),
      table_id: z
        .string()
        .describe("id of an already-created ToolJet DB table (from context)"),
    }),
    z.object({
      source: z.literal("sql"),
      name: z
        .string()
        .describe(
          "snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}",
        ),
      data_source_id: z
        .string()
        .describe("id of a connected data source (from the list in context)"),
      sql: z
        .string()
        .describe(
          "One SELECT statement against a table that data source has, e.g. SELECT * FROM orders LIMIT 100",
        ),
    }),
    z.object({
      source: z.literal("restapi"),
      name: z
        .string()
        .describe(
          "snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}",
        ),
      data_source_id: z
        .string()
        .describe("id of a connected REST API data source (from the list in context)"),
      method: z
        .enum(["get", "post", "put", "patch", "delete"])
        .default("get")
        .describe("HTTP method"),
      url: z
        .string()
        .describe(
          "Request path relative to the data source's base URL, e.g. /users/{{components.userId.value}}",
        ),
      headers: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .optional()
        .describe("Optional request headers"),
      params: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .optional()
        .describe("Optional URL query parameters"),
      body: z
        .string()
        .optional()
        .describe("Optional raw request body, e.g. a JSON string, for post/put/patch"),
    }),
    z.object({
      source: z.literal("plugin"),
      name: z
        .string()
        .describe(
          "snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}",
        ),
      data_source_id: z
        .string()
        .describe("id of a connected plugin data source (from the list in context)"),
      operation: z
        .string()
        .describe(
          "one of that data source's operation values, copied verbatim from its \"operations\" list in context",
        ),
      options: z
        .array(z.object({ key: z.string(), value: z.string() }))
        .optional()
        .describe(
          "the operation's own fields as key/value pairs (plugin- and operation-specific, e.g. channel/message for Slack's send_message)",
        ),
    }),
  ]),
});

// Planning-time only. It is the *plan* that must not contain a CreateTable against an
// external source of any kind other than postgresql (ADR-0018, narrowed by ADR-0042); a
// CreateQuery step has no CreateTable to propose, so telling it the same thing is noise in a
// prompt that already carries the whole PRD.
const NO_TABLES_IN_EXTERNAL_SOURCES =
  "Tables can only be created in ToolJet DB or a connected source whose kind above is 'postgresql' — never plan a CreateTable step against any other kind of connected source; query the tables it already has instead.";

// Both the planner and every CreateQuery step are grounded in the same connected-sources
// block, appended the same way, and neither gains anything when nothing is connected.
const withConnectedDataSources = (
  body: string,
  dataSources: QueryableDataSource[],
  { forPlanning = false }: { forPlanning?: boolean } = {},
): string => {
  const connectedSources = renderConnectedDataSources(dataSources);
  if (!connectedSources) return body;

  return [
    body,
    connectedSources,
    ...(forPlanning ? [NO_TABLES_IN_EXTERNAL_SOURCES] : []),
  ].join("\n\n");
};

// SQL keywords that must not appear in a generated query, and the single-statement
// read-only check, moved to ./services/query-security (ticket #67) so the UpdateQuery
// path validates the merged statement with exactly the same rules. `SELECT ... FOR UPDATE`
// is caught by this too — the intended reading: a query the AI wrote to feed a Table
// widget has no business taking row locks.

// Grounds a `Fix with AI` request (CONTEXT.md). The binding-syntax primer is the part that
// does the work: the model is being handed one expression with no surrounding app context
// (ADR-0013 — no App inventory is assembled for a fix), so what ToolJet's `{{ }}` runtime
// actually exposes has to come from the prompt or the model will invent plausible-looking
// references. The "return the whole field value" instruction matters just as much: the
// result is written into the field verbatim by `onAiSuggestionAccept`, never diffed.
const FIX_WITH_AI_SYSTEM_PROMPT = `You fix a single failing property expression on a component in a ToolJet app.

A ToolJet property field holds either a literal value or a JavaScript expression wrapped in double curly braces — for example {{ queries.getUsers.data }}, {{ components.table1.selectedRow.name }}, or {{ true }}. Inside the braces the app runtime exposes:
- queries.<name> — a data query's result: .data, .rawData, .isLoading
- components.<name> — a component's exposed values, e.g. components.textinput1.value
- globals.currentUser, globals.theme
- variables.<name> and constants.<name>

You are given one property whose expression failed to resolve, along with the error the runtime reported. Call proposeFix exactly once.

Rules:
- fixedValue is the complete replacement for the field, not a diff, a patch, or a fragment — whatever you return is written into the field verbatim.
- Keep the fix minimal and stay with the user's evident intent. Do not redesign the expression, rename things, or point it at a different data source than the one they clearly meant.
- Keep the {{ }} wrapper when the value is an expression; leave it off when the property should be a plain literal.
- When the error says something referenced does not exist, prefer correcting an obvious typo or casing slip over inventing a new reference. If nothing sensible can be inferred, fall back to a safe literal of the right shape and say so in the explanation.
- explanation is one short plain-language sentence, written for someone who does not know why their binding broke. Do not restate the raw error.`;

const proposeFixTool = tool({
  description: "Propose a corrected value for the failing component property.",
  parameters: z.object({
    fixedValue: z
      .string()
      .describe(
        "The complete replacement value for the property field, written verbatim into it",
      ),
    explanation: z
      .string()
      .describe("One short plain-language sentence explaining what was wrong"),
  }),
});

// Grounds a `Copilot` request (CONTEXT.md). The mirror image of FIX_WITH_AI_SYSTEM_PROMPT:
// that one hands the model one broken expression and no app context, this one hands it a
// whole query body to write and the `App inventory` to write it against (ADR-0016). The
// "only what the query body may contain" section is what keeps the answer pasteable — a
// model left to itself writes a module, with imports and a function declaration wrapped
// around the code, and a runjs field is neither.
const COPILOT_SYSTEM_PROMPT = `You write the body of a data query in a ToolJet app, from a plain-language description of what it should do.

The user is typing into one query editor. Whatever you return replaces that editor's entire contents, so it must be the complete body and nothing else — no markdown fences, no commentary, no import statements, and no surrounding function declaration. The body runs as-is.

Inside a query body the app runtime exposes:
- queries.<name>.run() — run another query and await its result; queries.<name>.data holds its last result
- components.<name> — a component's exposed values, e.g. components.textinput1.value
- globals.currentUser, globals.theme
- variables.<name> and constants.<name>
- parameters.<name> — the query's own declared parameters
The last expression a JavaScript body returns is the query's result; use an explicit \`return\`.

You are given an inventory of the app the user is working in. Use it:
- Reference only queries, components and pages that actually appear in it. Never invent a name — a name that does not exist resolves to undefined at runtime with no error, which is far worse for the user than code that does less.
- When the description asks for data that no existing query provides, write the body against what is there and say so in the explanation rather than inventing a query to call.

Call writeCode exactly once.

Rules:
- code is the complete replacement body for the editor, written in the language you are told the editor is in.
- When the editor already has code in it, treat it as the user's work in progress: extend, complete, or amend it to do what they asked, and keep the parts they did not ask you to change. Do not start over from a blank body unless the description clearly asks for something unrelated.
- Prefer the plainest thing that works. No defensive scaffolding, no configuration options, no abstraction the description did not ask for.
- explanation is one short plain-language sentence about what the code does, written for someone who is not going to read it line by line. Do not restate the code.`;

const writeCodeTool = tool({
  description: "Return the complete query body the user described.",
  parameters: z.object({
    code: z
      .string()
      .describe(
        "The complete replacement body for the editor, in the editor's language",
      ),
    explanation: z
      .string()
      .describe("One short plain-language sentence about what the code does"),
  }),
});

// The editor's current contents go into the prompt so a completion can extend the user's work
// rather than replace it blind (ADR-0016).
//
// The bound is deliberately far above any real query body (~5k tokens' worth), because
// truncating here is not free the way it is for a fix's fallback value: a `Completion` replaces
// the *whole* editor, so a model shown only part of the body would be asked to "keep what you
// weren't asked to change" while unable to see it, and the unseen head would vanish on Apply.
// Past this bound the existing code is dropped from the prompt entirely and the model is told
// so — an honestly-blind completion the user can reject beats a quietly lossy one.
const CURRENT_CODE_PROMPT_LIMIT = 20000;

// The editor reports CodeMirror's language name, which is what the model has to write in. An
// absent or unrecognised one defaults to javascript rather than being passed through: `runjs`
// is the overwhelmingly common surface, and a body silently generated in the wrong language is
// not a degraded answer, it is an unusable one.
const SUPPORTED_COPILOT_LANGUAGES = ["javascript", "python"];
const DEFAULT_COPILOT_LANGUAGE = "javascript";

// The fallback value arrives as parsed JSON from the request body, so it can't be circular —
// but it can be large (a whole query result standing in for a Table's `data`), and a fix
// prompt has no reason to carry more than enough of it to show the expected shape.
const FALLBACK_VALUE_PROMPT_LIMIT = 500;

const isNonEmptyString = (value: any): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isCodeTooLongToShow = (code: string): boolean =>
  code.length > CURRENT_CODE_PROMPT_LIMIT;

const summarizeFallbackValue = (value: any): string => {
  const serialized = JSON.stringify(value) ?? String(value);
  return serialized.length > FALLBACK_VALUE_PROMPT_LIMIT
    ? `${serialized.slice(0, FALLBACK_VALUE_PROMPT_LIMIT)}… (truncated)`
    : serialized;
};

// The machine event catalog (ticket #67) is injected into this prompt verbatim, appended
// in executeEventStep — the model may only pick eventIds/actionIds/keys from it, never
// invent strings.
const GENERATE_EVENT_SYSTEM_PROMPT = `You wire one event handler onto a component or a data query of this ToolJet app, based on the PRD and the specific step you've been asked to build.

Call generateEvent exactly once. You are given the catalog of valid eventIds per component type and valid actionIds with the exact keys each accepts — pick only from it. Never invent an event id or an action key: "rowClick" is not an event id, the Table's event is "onRowClicked".

Rules:
- targetName is the exact name of a component or query that appears in the context below — never invent one.
- params carries only the keys the chosen actionId lists in the catalog. Omit a key rather than set it to null/undefined. Values may be literals or {{ }} bindings to other components/queries that exist in this app.
- For control-component, componentSpecificActionParams must be an array (empty if the component action takes no arguments) and componentId is the target component's id from the context.
- One GenerateEvent attaches exactly one handler. If the PRD needs several events on the same target, that is several GenerateEvent steps.`;

const generateEventTool = tool({
  description:
    "Attach one event handler to a component or query that already exists in this plan.",
  parameters: z.object({
    targetName: z
      .string()
      .describe("Exact name of the component or query to attach the event to"),
    eventId: z
      .string()
      .describe("The event to react to, from the catalog (e.g. onClick)"),
    actionId: z
      .string()
      .describe("The action to run, from the catalog (e.g. show-modal)"),
    params: z
      .record(z.any())
      .optional()
      .describe(
        "Action-specific keys exactly as the catalog lists them for this actionId",
      ),
  }),
});

type StepExecutionContext = {
  prd: string;
  organizationId: string;
  appVersionId: string;
  priorResults: Array<{ type: StepType; artifact: Artifact }>;
  // Assembled once per approval, not per step: reading it opens a real connection to each
  // connected source, and the answer cannot change while a plan is being executed.
  dataSources: QueryableDataSource[];
  // Ticket #77 / ADR-0042: the same SSE response approvePrd already streams step-progress
  // events on — an external CreateTable step's confirmation gate sends its
  // step-awaiting-confirmation event through this, not a parallel channel.
  response: Response;
  // ADR-0044: raiseInterrupt reads/writes this conversation's metadata to pause on, and
  // needs the id to do it — nothing else in the context identifies which conversation a
  // step belongs to.
  conversationId: string;
};

@Injectable()
export class AiService implements IAiService {
  private readonly logger = new Logger(AiService.name);

  private readonly SUPPORTED_STEP_TYPES: StepType[] = [
    "CreateTable",
    "UpdateTable",
    "CreateComponent",
    "CreateQuery",
    "UpdateComponent",
    "DeleteComponent",
    "MoveComponent",
    "UpdateQuery",
    "DeleteQuery",
    "GenerateEvent",
  ];
  private readonly MAX_STEP_ATTEMPTS = 3; // 1 initial attempt + 2 retries, per ticket acceptance criteria

  // Ticket #77 / ADR-0042: the external CreateTable confirmation gate is checkpoint-based
  // like ADR-0021's Skip, not event-driven — the SSE connection stays open (the existing
  // beginActiveRun heartbeat keeps it alive) while this polls the Step row for the decision
  // the confirm-step endpoint records. Not `readonly`: tests override both to keep the poll
  // loop fast without waiting on real wall-clock time.
  private CONFIRMATION_POLL_INTERVAL_MS = 3000;
  private CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  // ADR-0044: same checkpoint-poll shape as the confirmation gate above, generalized onto
  // conversation.metadata.interrupt instead of a Step's status column. Not `readonly`, for
  // the same reason as the pair above — tests override both to avoid real wall-clock waits.
  private INTERRUPT_POLL_INTERVAL_MS = 3000;
  private INTERRUPT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

  constructor(
    private readonly aiUtilService: AiUtilService,
    private readonly aiConversationRepository: AiConversationRepository,
    private readonly aiConversationMessageRepository: AiConversationMessageRepository,
    private readonly agentsService: AgentsService,
    private readonly artifactRepository: ArtifactRepository,
    private readonly stepRepository: StepRepository,
    private readonly versionRepository: VersionRepository,
    private readonly aiResponseVoteRepository: AiResponseVoteRepository,
    private readonly appInventoryService: AppInventoryService,
    private readonly dataSourceInventoryService: DataSourceInventoryService,
    private readonly aiActiveRunService: AiActiveRunService,
    private readonly aiFeasibilityService: AiFeasibilityService,
    private readonly generationEngineClient: GenerationEngineClient,
  ) {}

  /**
   * Registers an active run for a streaming AI Builder operation, starts a heartbeat
   * that keeps the run alive, and returns a cleanup function that must be called when
   * the stream ends (success, error, or client disconnect).
   */
  private async beginActiveRun(
    conversationId: string,
    userId: string,
    organizationId: string,
    response: Response,
  ): Promise<() => void> {
    await this.aiActiveRunService.beginRun(
      conversationId,
      userId,
      organizationId,
    );

    const heartbeat = setInterval(() => {
      this.aiActiveRunService.touchRun(conversationId).catch((error) => {
        this.logger.error(
          `[activeRun] heartbeat failed for conversationId=${conversationId}`,
          error?.message,
        );
      });
    }, 5000);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.aiActiveRunService.endRun(conversationId).catch((error) => {
        this.logger.error(
          `[activeRun] endRun failed for conversationId=${conversationId}`,
          error?.message,
        );
      });
    };

    response.once("close", cleanup);
    response.once("finish", cleanup);

    return cleanup;
  }

  /**
   * Loads the conversation `conversationId` names and asserts it is of `expectedType`.
   *
   * Every entry point that only makes sense for one kind of conversation goes through here:
   * `approvePrd`/`rewindStep` are Generate-only (a Learn conversation has no PRD, no Steps and
   * no Artifacts — CONTEXT.md), and `sendUserDocsMessage`/`promoteConversation` are Learn-only.
   * Since `conversationType` is fixed at creation and never mutated (ADR-0012), a mismatch is
   * always a caller error rather than a state the conversation can grow out of.
   */
  /**
   * Loads the conversation `conversationId` names and asserts it is of `expectedType` and
   * owned by `userId`.
   *
   * Every entry point that only makes sense for one kind of conversation goes through here:
   * `approvePrd`/`rewindStep` are Generate-only (a Learn conversation has no PRD, no Steps and
   * no Artifacts — CONTEXT.md), and `sendUserDocsMessage`/`promoteConversation` are Learn-only.
   * Since `conversationType` is fixed at creation and never mutated (ADR-0012), a mismatch is
   * always a caller error rather than a state the conversation can grow out of.
   *
   * Ownership is enforced here (the single choke-point for every conversation-scoped entry
   * point) so a caller can't read or mutate a conversation they don't own just by knowing its
   * UUID. The owner check is folded into the same `NotFoundException` as the existence check so
   * the route doesn't leak whether a foreign conversation exists.
   */
  private async loadConversationOfType(
    conversationId: string,
    expectedType: ConversationType,
    userId: string,
  ): Promise<AiConversation> {
    const conversation =
      await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException("Conversation not found");
    }
    if (conversation.conversationType !== expectedType) {
      throw new BadRequestException(
        `This action is only available in a "${expectedType}" conversation, but this one is "${conversation.conversationType}"`,
      );
    }
    return conversation;
  }

  /**
   * Static, hardcoded landing-state content for the chat panel's empty state.
   * No LLM call — this is just example prompts to help a user get started.
   */
  async fetchZeroStateConfig(firstName: string): Promise<{
    user: { name: string; greeting: string; description: string };
    suggestions: Array<{ icon: string; label: string; action: string }>;
  }> {
    const name = firstName || "there";

    return {
      user: {
        name,
        greeting: `Hi ${name}, what would you like to build today?`,
        description:
          "Describe your app idea and I will help you turn it into a working ToolJet app.",
      },
      suggestions: [
        {
          icon: "inventory",
          label: "Inventory tracker",
          action:
            "Build an inventory tracker for a small warehouse with low-stock alerts.",
        },
        {
          icon: "crm",
          label: "Customer CRM",
          action:
            "Build a simple CRM to track leads, contacts, and deal stages.",
        },
        {
          icon: "dashboard",
          label: "Support dashboard",
          action:
            "Build a support ticket dashboard for my team with status filters.",
        },
        {
          icon: "form",
          label: "Approval workflow",
          action: "Build an approval workflow for employee expense requests.",
        },
      ],
    };
  }

  /**
   * Upserts the single vote row for `messageId` (ADR-0009: AiResponseVote is a OneToOne
   * off AiConversationMessage, one row per message — not per user, so a second vote just
   * overwrites the first rather than creating a duplicate).
   */
  async voteAiMessage(
    messageId: string,
    voteType: string,
    userId: string,
  ): Promise<any> {
    if (!messageId || !voteType) {
      throw new BadRequestException("messageId and voteType are required");
    }
    if (voteType !== "up" && voteType !== "down") {
      throw new BadRequestException('voteType must be "up" or "down"');
    }

    const message =
      await this.aiConversationMessageRepository.findMessageById(messageId);
    if (!message) {
      throw new NotFoundException("Message not found");
    }

    // A vote is written against a conversation, so ownership is verified through it even though
    // the endpoint takes the message id directly (otherwise knowing a message UUID lets any user
    // attach a vote row to someone else's thread).
    const conversation = await this.aiConversationRepository.findById(
      message.aiConversationId,
    );
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException("Message not found");
    }

    const vote = voteType as "up" | "down";
    const existingVote =
      await this.aiResponseVoteRepository.findByMessageId(messageId);
    if (existingVote) {
      await this.aiResponseVoteRepository.updateOne(existingVote.id, {
        voteType: vote,
        userId,
      });
      return { ...existingVote, voteType: vote, userId };
    }

    return await this.aiResponseVoteRepository.createOne({
      aiConversationMessageId: messageId,
      userId,
      voteType: vote,
    });
  }

  /**
   * Approves a PRD and executes it (ADR-0001 phase two): generates the full ordered
   * Step list once from the PRD (ADR-0004), then walks it in order over the same SSE
   * connection, executing each Step with up to 2 retries before treating it as an
   * unrecoverable failure.
   *
   * SSE event contract (in addition to sendUserMessage's chunk/done/error):
   *  - `plan`         (once):     { steps: [{ id, type, description, table? }] } — table is the
   *                                 planned table definition on CreateTable steps (ticket #20)
   *  - `step-progress` (per step): { step, of, description } — sent before executing a step
   *  - `step-done`     (per step): { step, of, artifact } — the step's persisted Artifact
   *  - `step-failed`   (at most once): { step, of, message } — the step that stopped execution
   *  - `done`          (once):    { succeeded, total, message? } — message is set only on failure-stop
   *
   * On unrecoverable failure, Steps/Artifacts already persisted for earlier steps are left
   * as-is (CONTEXT.md: "already-succeeded Artifacts remain applied"); a failure
   * AiConversationMessage is posted so the failure is visible in conversation history too,
   * not just in the SSE stream that already ended.
   */
  async approvePrd(
    conversationId: string,
    prd: any,
    user: User,
    userPermissions: UserPermissions,
    response: Response,
    dataSourceId?: string,
  ): Promise<any> {
    if (!conversationId || !prd) {
      throw new BadRequestException("conversationId and prd are required");
    }
    const organizationId = user.organizationId;

    // Raised before any SSE header is written, so a Learn conversation's caller gets a real
    // non-2xx + JSON body (which the client's `onopen` handler surfaces) rather than a stream
    // that opens and then immediately errors.
    const conversation = await this.loadConversationOfType(
      conversationId,
      "generate",
      user.id,
    );

    const conversationMessages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );
    const prdMessage = [...conversationMessages]
      .reverse()
      .find((message) => message.messageType === "ai");
    if (!prdMessage) {
      throw new BadRequestException("No PRD message found to approve");
    }

    this.aiUtilService.initSSE(response);
    this.aiUtilService.startHeartbeat(response);
    const endActiveRun = await this.beginActiveRun(
      conversation.id,
      user.id,
      user.organizationId,
      response,
    );

    try {
      const appVersionId = await this.resolveAppVersionId(conversation.appId);
      const dataSources =
        await this.dataSourceInventoryService.listQueryableSources(
          user,
          userPermissions,
        );
      // Ticket #20: Steps persisted by an earlier previewPlan call for this same PRD message
      // are reused as-is — what the user previewed (including each CreateTable step's planned
      // table definition) is exactly what executes. A PRD refined after the preview produces a
      // new AI message, whose (empty) pending set falls through to a fresh plan.
      const steps = await this.resolvePlanForPrdMessage(
        conversationId,
        prdMessage,
        organizationId,
        dataSources,
        appVersionId,
        prd,
      );
      // ADR-0018: when the user explicitly selects an external source, CreateTable steps
      // (which only make sense against ToolJet DB) are stripped from the plan before it is
      // persisted or executed. The planner is also told this constraint via the connected-
      // sources block, but the filter is the safety net — the planner can still propose one
      // in edge cases (e.g. when the prompt is long and the constraint is buried).
      const filteredSteps = dataSourceId
        ? steps.filter((step) => step.type !== "CreateTable")
        : steps;

      this.aiUtilService.sendSSE(response, "plan", {
        steps: this.mapStepsForWire(filteredSteps),
      });

      const context: StepExecutionContext = {
        prd,
        organizationId,
        appVersionId,
        priorResults: [],
        dataSources,
        response,
        conversationId,
      };

      for (let index = 0; index < filteredSteps.length; index++) {
        const step = filteredSteps[index];
        // Ticket #21: skip is checkpoint-based — a step the user skipped (while it was
        // pending, e.g. during an earlier step's execution) is detected here and never
        // starts, so no Artifact is made for it.
        if (
          (await this.stepRepository.findById(step.id))?.status === "skipped"
        ) {
          this.sendStepSkippedSSE(
            response,
            index,
            filteredSteps.length,
            step.description,
          );
          continue;
        }
        await this.stepRepository.updateOne(step.id, { status: "running" });
        this.aiUtilService.sendSSE(response, "step-progress", {
          step: index + 1,
          of: filteredSteps.length,
          description: step.description,
        });

        const outcome = await this.executeStepWithRetry(step, context);

        // Ticket #21: the user may have skipped this step while it was executing (the skip
        // endpoint marks a running step 'skipped' without interrupting the in-flight work —
        // executeStepWithRetry deliberately leaves that status unclobbered, either terminal
        // one). Its outcome is discarded: the Artifact it produced is undone through the
        // same calls rewindStep (ADR-0008) makes, so a skipped step never leaves anything
        // behind. Skip wins over retry (ticket #4): even a step that succeeded after all
        // MAX_STEP_ATTEMPTS is discarded here.
        if (
          outcome.skipped ||
          (await this.stepRepository.findById(step.id))?.status === "skipped"
        ) {
          if (outcome.success && outcome.artifact) {
            await this.discardStepArtifact(
              step,
              appVersionId,
              organizationId,
              outcome.artifact,
            );
          }
          this.sendStepSkippedSSE(
            response,
            index,
            filteredSteps.length,
            step.description,
          );
          continue;
        }

        if (outcome.success) {
          context.priorResults.push({
            type: step.type,
            artifact: outcome.artifact,
          });
          this.aiUtilService.sendSSE(response, "step-done", {
            step: index + 1,
            of: filteredSteps.length,
            artifact: outcome.artifact,
          });
          continue;
        }

        const failureMessage =
          await this.aiConversationMessageRepository.createOne({
            aiConversationId: conversationId,
            messageType: "ai",
            content: `The build stopped at step ${index + 1} of ${filteredSteps.length} ("${step.description}"): ${outcome.errorMessage}`,
            parentId: prdMessage.id,
            isLatest: true,
          });
        this.aiUtilService.sendSSE(response, "step-failed", {
          step: index + 1,
          of: filteredSteps.length,
          message: outcome.errorMessage,
        });
        this.aiUtilService.sendSSE(response, "done", {
          message: failureMessage,
          succeeded: context.priorResults.length,
          total: filteredSteps.length,
        });
        response.end();
        return;
      }

      this.aiUtilService.sendSSE(response, "done", {
        succeeded: context.priorResults.length,
        total: filteredSteps.length,
      });
      response.end();
    } catch (error) {
      this.logger.error(
        `[approvePrd] conversationId=${conversationId} failed: ${error?.message}`,
        error?.stack,
      );
      this.aiUtilService.sendSSE(response, "error", {
        message: error?.message || "Failed to build the plan",
      });
      response.end();
    } finally {
      endActiveRun();
    }
  }

  /**
   * Ticket #20: generates (or reuses) the build plan for the conversation's latest PRD and
   * returns it as plain JSON — no SSE, nothing executes. Each CreateTable step carries its
   * concrete proposed table definition so the client can render a structured schema preview
   * before approval. Steps persisted here stay pending; approvePrd reuses them instead of
   * re-running the planner, so the previewed plan is the executed plan. Previewing twice is
   * idempotent: the second call is served from the first call's pending Steps.
   */
  async previewPlan(
    conversationId: string,
    user: User,
    userPermissions: UserPermissions,
    dataSourceId?: string,
  ) {
    if (!conversationId) {
      throw new BadRequestException("conversationId is required");
    }
    // Same rules as approvePrd: generate conversations only, caller-owned, PRD message required.
    const conversation = await this.loadConversationOfType(
      conversationId,
      "generate",
      user.id,
    );

    const organizationId = user.organizationId;
    const appVersionId = await this.resolveAppVersionId(conversation.appId);
    const conversationMessages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );
    const prdMessage = [...conversationMessages]
      .reverse()
      .find((message) => message.messageType === "ai");
    if (!prdMessage) {
      throw new BadRequestException("No PRD message found to plan from");
    }

    const dataSources =
      await this.dataSourceInventoryService.listQueryableSources(
        user,
        userPermissions,
      );
    const steps = await this.resolvePlanForPrdMessage(
      conversationId,
      prdMessage,
      organizationId,
      dataSources,
      appVersionId,
    );

    // Same ADR-0018 safety net as approvePrd: with an external source selected, CreateTable
    // steps (and their planned tables) are stripped from what the preview shows.
    const filteredSteps = dataSourceId
      ? steps.filter((step) => step.type !== "CreateTable")
      : steps;
    return { steps: this.mapStepsForWire(filteredSteps) };
  }

  /**
   * Returns the active run for a conversation, or null if none. Ownership is enforced so a
   * caller cannot probe another user's conversations.
   */
  async getActiveRun(
    conversationId: string,
    userId: string,
  ): Promise<{ active: boolean; startedAt?: Date }> {
    const conversation =
      await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException("Conversation not found");
    }

    const run = await this.aiActiveRunService.findActiveRun(conversationId);
    if (!run) {
      return { active: false };
    }

    return { active: true, startedAt: run.startedAt };
  }

  /**
   * The plan for one PRD message: pending Steps persisted by an earlier previewPlan call
   * (ticket #20) when they exist, otherwise a freshly generated plan. Shared by previewPlan
   * and approvePrd on purpose — the previewed plan has to be the executed plan, so both
   * callers must resolve it the same way.
   */
  private async resolvePlanForPrdMessage(
    conversationId: string,
    prdMessage: AiConversationMessage,
    organizationId: string,
    dataSources: QueryableDataSource[],
    appVersionId: string,
    prd?: string,
  ): Promise<Step[]> {
    let steps = await this.stepRepository.findPendingForMessage(
      conversationId,
      prdMessage.id,
    );
    if (!steps.length) {
      steps = await this.generateStepPlan(
        prd ?? prdMessage.content,
        conversationId,
        prdMessage.id,
        organizationId,
        dataSources,
        appVersionId,
      );
    }
    return steps;
  }

  // One Step as it travels to the client (plan SSE event, preview response). The planned
  // table (ticket #20) rides along on CreateTable steps so the schema preview renders the
  // definition that execution will create verbatim; the planned seed rows (ticket #48) ride
  // along for the same reason — the preview shows the data that will be inserted.
  private mapStepsForWire(steps: Step[]) {
    return steps.map((step) => ({
      id: step.id,
      type: step.type,
      description: step.description,
      ...(step.phase && { phase: step.phase }),
      ...(step.plannedTable && { table: step.plannedTable }),
      ...(step.plannedSeedRows && { seed_rows: step.plannedSeedRows }),
      // Ticket #77 / ADR-0042: present only when this CreateTable step targets a connected
      // PostgreSQL source instead of ToolJet DB — the schema preview (ADR-0020) uses this to
      // show the target connection alongside the table definition.
      ...(step.targetDataSourceId && {
        target_data_source_id: step.targetDataSourceId,
      }),
      ...(step.props?.collisionError && {
        collision_error: step.props.collisionError,
      }),
    }));
  }

  /**
   * Resolves "the" AppVersion an AI Builder conversation is scoped to — the app's
   * earliest-created version, matching the intent of the human-triggered pages endpoint's
   * convention (`pages.controller.ts`: `app.appVersions[0].id`). VersionRepository.getAllVersions
   * doesn't sort its result, so sorting here (rather than trusting array order) is what
   * actually makes "the first version" deterministic — the AI Builder doesn't yet
   * distinguish draft/released versions, so this is simply the app's original version.
   *
   * Shared by both conversation types on purpose: the version an approved plan builds into and
   * the version a Learn conversation's App inventory is read from have to be the same one, or
   * the assistant would be answering questions about a version nothing was built into.
   */
  private async resolveAppVersionId(appId: string): Promise<string> {
    const versions = await this.versionRepository.getAllVersions(appId);
    if (!versions?.length) {
      throw new Error("This app has no version to work with");
    }
    const sorted = [...versions].sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    return sorted[0].id;
  }

  /**
   * Ticket #58: fits a generate-path prompt (`system` + `messages`) into the context window
   * of the provider the request will actually use. The chat streaming paths budget through
   * `fitMessagesToContextWindowForOrg` directly; this wraps the same fitting for the
   * tool-forced `AIGatewayGenerate` calls (step plan, step execution, fix-with-AI, Copilot),
   * which share one priority order: system prompt first, then the remaining messages.
   * Truncation is logged here per path, the same way the chat paths log it.
   */
  private async budgetPromptForOrg(
    organizationId: string,
    prompt: {
      system: string;
      messages: Array<{ role: string; content: string }>;
    },
    logContext: string,
  ): Promise<{
    system: string;
    messages: Array<{ role: string; content: string }>;
  }> {
    const { messages: fitted, truncated } =
      await this.aiUtilService.fitMessagesToContextWindowForOrg(
        organizationId,
        [{ role: "system", content: prompt.system }, ...prompt.messages],
      );
    if (truncated.length) {
      this.logger.warn(
        `[${logContext}] context truncated: ${JSON.stringify(truncated)}`,
      );
    }
    // Pass 1 of the fitter always keeps the first system message (possibly trimmed to an
    // empty string), so the destructure below never loses the prompt to a dropped message.
    const [systemMessage, ...rest] = fitted;
    return {
      system: systemMessage?.content ?? "",
      messages: rest,
    };
  }

  /**
   * One LLM call (ADR-0004) that decides the plan's shape and order from the PRD text —
   * persists a Step row per proposed step, in order, all `status: 'pending'`.
   */
  private async generateStepPlan(
    prd: string,
    conversationId: string,
    messageId: string,
    organizationId: string,
    dataSources: QueryableDataSource[],
    appVersionId: string,
  ): Promise<Step[]> {
    // Ticket #66: the planner needs to know an UpdateComponent target actually exists before
    // it can propose one — same "never invent an id" contract as the connected-sources block
    // below.
    const componentIndex =
      await this.appInventoryService.renderComponentIndex(appVersionId);
    const prompt = await this.budgetPromptForOrg(
      organizationId,
      {
        system: STEP_PLAN_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: withConnectedDataSources(
              `${prd}\n\n${componentIndex}`,
              dataSources,
              { forPlanning: true },
            ),
          },
        ],
      },
      "generateStepPlan",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-plan",
      {
        ...prompt,
        tools: { proposeStepPlan: proposeStepPlanTool },
        toolChoice: { type: "tool", toolName: "proposeStepPlan" },
      },
      organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "proposeStepPlan") {
      throw new Error("The assistant did not propose a build plan");
    }

    const { steps: proposedSteps } = call.args as {
      steps: Array<{
        type: StepType;
        description: string;
        table?: TableDefinition;
        data_source_id?: string;
        seed_rows?: any[];
        phase?: string;
      }>;
    };
    if (!proposedSteps?.length) {
      throw new Error("The assistant proposed an empty build plan");
    }

    const persisted: Step[] = [];
    for (let index = 0; index < proposedSteps.length; index++) {
      const proposed = proposedSteps[index];
      // Ticket #20: a CreateTable step carries its concrete proposed definition, which the
      // schema preview renders and executeCreateTableStep later creates verbatim. A
      // malformed one is dropped rather than persisted — execution then falls back to the
      // per-step LLM path instead of trusting a half-formed contract.
      const plannedTable =
        proposed.type === "CreateTable" &&
        isWellFormedTableDefinition(proposed.table)
          ? proposed.table
          : undefined;
      // Ticket #48: seed rows ride on the same CreateTable steps, dropped when malformed —
      // execution then creates the table without seeding instead of trusting a half-formed
      // contract (same policy as a malformed planned table). Malformed includes rows that
      // name columns the planned table doesn't have: the spec's "INSERTs consistent with
      // the planned schema" is checked here, against the planner's own table proposal, so
      // a hallucinated column fails at plan time (the preview never shows it) rather than
      // mid-execution. Rows are only trusted when the table definition they seed is too.
      const plannedSeedRows =
        proposed.type === "CreateTable" &&
        isWellFormedTableDefinition(proposed.table) &&
        isWellFormedSeedRows(proposed.seed_rows) &&
        areSeedRowsConsistentWithTable(proposed.seed_rows, proposed.table)
          ? proposed.seed_rows
          : undefined;
      // Ticket #77 / ADR-0042: only a well-formed planned table can be checked for a name
      // collision or actually targeted externally — the per-step LLM fallback path (no
      // planned table) always stays on ToolJet DB, same as before this ticket.
      const targetResolution = plannedTable
        ? resolveCreateTableTarget(
            proposed.data_source_id,
            plannedTable.table_name,
            dataSources,
          )
        : { kind: "tjdb" as const };
      // Ticket #21: the planner-assigned phase name, trimmed; an absent/blank one persists
      // as null so the client's fallback grouping sees a consistent shape.
      const phase = proposed.phase?.trim() || null;
      const step = await this.stepRepository.createOne({
        conversationId,
        messageId,
        order: index,
        type: proposed.type,
        description: proposed.description,
        // A collision is a terminal, plan-time-decided failure (ADR-0042): the step is
        // persisted without its planned table so executeCreateTableStep never takes the
        // deterministic create path, and props.collisionError is what it throws on
        // instead — surfaced through the normal step-failed channel, not a silent drop.
        ...(targetResolution.kind !== "collision" &&
          plannedTable && { plannedTable }),
        ...(targetResolution.kind !== "collision" &&
          plannedSeedRows && { plannedSeedRows }),
        ...(targetResolution.kind === "collision" && {
          props: { collisionError: targetResolution.message },
        }),
        ...(targetResolution.kind === "external" && {
          targetDataSourceId: targetResolution.dataSource.id,
        }),
        ...(phase && { phase }),
        status: "pending",
      });
      persisted.push(step);
    }
    return persisted;
  }

  /**
   * Executes one Step, retrying up to MAX_STEP_ATTEMPTS times (each retry's LLM call is
   * told what the previous attempt's error was, so it can actually correct course rather
   * than repeat the same mistake). An unsupported step type (ADR-0006) fails immediately —
   * retrying a handler that doesn't exist can't ever succeed.
   */
  // A flat (not discriminated-union) result shape on purpose: this repo's tsconfig
  // doesn't enable strictNullChecks, and without it TS control-flow narrowing on
  // `{success:true;...}|{success:false;...}` unions doesn't reliably narrow at call
  // sites (verified in isolation) — so callers check `.success` and read the other
  // fields directly instead of relying on narrowing to make them "exist".
  private async executeStepWithRetry(
    step: Step,
    context: StepExecutionContext,
  ): Promise<{
    success: boolean;
    artifact?: Artifact;
    errorMessage?: string;
    skipped?: boolean;
  }> {
    if (!this.SUPPORTED_STEP_TYPES.includes(step.type)) {
      const errorMessage = `Unsupported step type "${step.type}" — not yet implemented`;
      await this.stepRepository.updateOne(step.id, {
        status: "failed",
        errorMessage,
      });
      return { success: false, errorMessage };
    }

    let lastError: string;
    for (let attempt = 1; attempt <= this.MAX_STEP_ATTEMPTS; attempt++) {
      try {
        const { content, identifier, props } = await this.executeStep(
          step,
          context,
          lastError,
        );

        // Ticket #21: a step the user skipped mid-run must not be recorded with either
        // terminal status — the execution loop owns that transition (step-skipped), and
        // overwriting 'skipped' with 'succeeded'/'failed' here would make the skip silently
        // vanish. The Artifact row is still created, so the loop can undo the real change
        // this attempt already made before discarding it.
        const skipped =
          (await this.stepRepository.findById(step.id))?.status === "skipped";
        const artifact = await this.artifactRepository.createOne({
          conversationId: step.conversationId,
          messageId: step.messageId,
          content,
          identifier,
        });
        await this.stepRepository.updateOne(step.id, {
          ...(skipped ? {} : { status: "succeeded" }),
          props,
          attempts: attempt,
          artifactId: artifact.id,
        });
        return { success: true, artifact, skipped };
      } catch (error) {
        lastError = error?.message || "Step execution failed";
        this.logger.warn(
          `[approvePrd] step=${step.id} type=${step.type} attempt=${attempt} failed: ${lastError}`,
        );
        await this.stepRepository.updateOne(step.id, {
          attempts: attempt,
          errorMessage: lastError,
        });
      }
    }

    // Same guard on the failed terminal write: a step skipped while its retries ran is
    // reported back as skipped, not failed — the plan continues instead of stopping.
    const skipped =
      (await this.stepRepository.findById(step.id))?.status === "skipped";
    if (!skipped) {
      await this.stepRepository.updateOne(step.id, {
        status: "failed",
        errorMessage: lastError,
      });
    }
    return { success: false, errorMessage: lastError, skipped };
  }

  /**
   * Ticket #21: undoes the Artifact a skipped-while-running step produced, with the same
   * calls rewindStep (ADR-0008) makes for every discarded step.
   */
  private async discardStepArtifact(
    step: Step,
    appVersionId: string,
    organizationId: string,
    artifact: Artifact,
  ): Promise<void> {
    await this.agentsService.undoArtifact(
      step.type,
      appVersionId,
      organizationId,
      artifact.content,
    );
    await this.artifactRepository.deleteOne(artifact.id);
    await this.stepRepository.updateOne(step.id, { artifactId: null });
  }

  private sendStepSkippedSSE(
    response: Response,
    index: number,
    of: number,
    description: string,
  ): void {
    this.aiUtilService.sendSSE(response, "step-skipped", {
      step: index + 1,
      of,
      description,
    });
  }

  private async executeStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    switch (step.type) {
      case "CreateTable":
        return this.executeCreateTableStep(step, context, previousError);
      case "UpdateTable":
        return this.executeUpdateTableStep(step, context, previousError);
      case "CreateComponent":
        return this.executeComponentStep(step, context, previousError);
      case "UpdateComponent":
        return this.executeUpdateComponentStep(step, context, previousError);
      case "DeleteComponent":
        return this.executeDeleteComponentStep(step, context, previousError);
      case "MoveComponent":
        return this.executeMoveComponentStep(step, context, previousError);
      case "CreateQuery":
        return this.executeQueryStep(step, context, previousError);
      case "UpdateQuery":
        return this.executeUpdateQueryStep(step, context, previousError);
      case "DeleteQuery":
        return this.executeDeleteQueryStep(step, context, previousError);
      case "GenerateEvent":
        return this.executeEventStep(step, context, previousError);
      default:
        throw new Error(`Unsupported step type "${step.type}"`);
    }
  }

  /**
   * Shared "PRD + this step's job + what earlier steps in this plan already built + what
   * went wrong last attempt" preamble every per-step LLM call is grounded in. Prior results
   * are serialized with their full Artifact.content (not just `identifier`) since later
   * steps need real ids to reference — e.g. CreateQuery needs a CreateTable step's actual
   * table id, not just its human-readable table_name.
   */
  private buildStepContextLines(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): string {
    const lines = [
      `PRD:\n${context.prd}`,
      `Step to build: ${step.description}`,
    ];
    if (context.priorResults.length) {
      const summary = context.priorResults
        .map(
          (result) =>
            `- ${result.type} → ${JSON.stringify(result.artifact.content)}`,
        )
        .join("\n");
      lines.push(
        `Already created earlier in this plan (reference real ids/names from here, never invent one):\n${summary}`,
      );
    }
    if (previousError) {
      lines.push(
        `The previous attempt failed with: "${previousError}". Fix the issue and try again.`,
      );
    }
    return lines.join("\n\n");
  }

  // Maps a (planner-proposed or LLM-proposed) table definition into the params
  // AgentsService.CreateTable forwards to the ToolJet DB backend. The foreign_keys entry is
  // forwarded verbatim: the backend CreatePostgrestTableDto's PostgrestForeignKeyDto uses the
  // same field names.
  private buildTableParams(table: TableDefinition) {
    return {
      table_name: table.table_name,
      columns: table.columns.map((column) => ({
        column_name: column.column_name,
        data_type: column.data_type,
        constraints_type: {
          is_primary_key: column.is_primary_key,
          is_not_null: column.is_not_null,
          is_unique: column.is_unique,
        },
      })),
      ...(table.foreign_keys && { foreign_keys: table.foreign_keys }),
      ...(table.indexes && { indexes: table.indexes }),
    };
  }

  /**
   * Deterministic pre-flight for a table's foreign_keys (ticket #23, the same
   * validate-and-retry seam as pageId/queryName): a referenced table must either be one
   * this plan created earlier or already exist in the organization's ToolJet DB. Without
   * this, a hallucinated reference fails deep inside TooljetDbTableOperationsService with
   * an error that names neither the missing table nor what does exist — and the planned-
   * table path (which makes no LLM call) would burn all retries on it. Thrown errors are
   * retryable: on the LLM path the message is fed back as previousError.
   */
  private async validateForeignKeys(
    tableParams: any,
    context: StepExecutionContext,
  ): Promise<void> {
    const foreignKeys = tableParams?.foreign_keys ?? [];
    if (!foreignKeys.length) return;

    // Malformed entries (legacy plans persisted before #23's schema) can't name a real
    // table — treat them as unknown so the error names them instead of printing "undefined".
    const referencedNames = foreignKeys.map((foreignKey) =>
      typeof foreignKey?.referenced_table_name === "string"
        ? foreignKey.referenced_table_name
        : null,
    );
    const planTableNames = new Set(
      context.priorResults
        .filter((result) => result.type === "CreateTable")
        .map((result) => result.artifact.content?.table_name)
        .filter(Boolean),
    );
    if (
      referencedNames.every((name) => name !== null && planTableNames.has(name))
    )
      return;

    const existingTables = await this.agentsService.ViewTables(
      context.organizationId,
    );
    const existingTableNames = new Set(
      existingTables.map((table) => table.tableName),
    );

    const unknownTables = [
      ...new Set(
        referencedNames.filter(
          (name) =>
            name === null ||
            (!planTableNames.has(name) && !existingTableNames.has(name)),
        ),
      ),
    ];
    if (unknownTables.length) {
      const available = [
        ...new Set([...planTableNames, ...existingTableNames]),
      ].sort();
      throw new Error(
        `foreign_keys reference table(s) that do not exist in this app: ${unknownTables.join(", ")}. ` +
          `Available tables: ${available.length ? available.join(", ") : "(none yet)"}`,
      );
    }
  }

  /**
   * Ticket #77 / ADR-0042: the execution-time confirmation gate for a CreateTable step whose
   * resolved target is external — new execution-loop state, not a new terminal Step status,
   * distinct from ADR-0021's Skip. Sits between the step becoming 'running' and the DDL call
   * itself. Blocks (polling the Step row, not the event loop) until the confirm-step endpoint
   * records a decision, or throws on decline/timeout — either way, no DDL is ever issued
   * before this returns normally.
   *
   * Re-entrant on retry: a second/third attempt (executeStepWithRetry) calls this again: if
   * the step is already 'confirmed' it returns immediately without re-sending the SSE event;
   * if already 'skipped' (declined) it throws immediately, cheaply, without polling again.
   */
  private async awaitExternalTableConfirmation(
    step: Step,
    context: StepExecutionContext,
    targetDataSource: QueryableDataSource,
  ): Promise<void> {
    const current = await this.stepRepository.findById(step.id);
    if (current?.status === "skipped") {
      throw new Error(
        "This CreateTable step targeting an external PostgreSQL source was declined — no DDL was issued.",
      );
    }
    if (current?.status === "confirmed") return;

    if (current?.status !== "awaiting_confirmation") {
      await this.stepRepository.updateOne(step.id, {
        status: "awaiting_confirmation",
      });
      this.aiUtilService.sendSSE(
        context.response,
        "step-awaiting-confirmation",
        {
          stepId: step.id,
          tableName: step.plannedTable?.table_name,
          columns: step.plannedTable?.columns ?? [],
          targetConnection: {
            id: targetDataSource.id,
            name: targetDataSource.name,
          },
          seedRowCount: Array.isArray(step.plannedSeedRows)
            ? step.plannedSeedRows.length
            : 0,
        },
      );
    }

    const deadline = Date.now() + this.CONFIRMATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.CONFIRMATION_POLL_INTERVAL_MS),
      );
      const polled = await this.stepRepository.findById(step.id);
      if (polled?.status === "confirmed") return;
      if (polled?.status === "skipped") {
        throw new Error(
          "This CreateTable step targeting an external PostgreSQL source was declined — no DDL was issued.",
        );
      }
    }
    throw new Error(
      "Timed out waiting for confirmation on a CreateTable step targeting an external PostgreSQL source.",
    );
  }

  /**
   * ADR-0044: generic pause point. Writes conversation.metadata.interrupt, sends the
   * `interrupt` SSE event on the same response `awaitExternalTableConfirmation` streams on,
   * then polls conversation.metadata for an `answer` written by `interruptAnswer` (a
   * separate HTTP request) — the confirmation gate's checkpoint shape, generalized off of
   * a Step's status column onto conversation metadata (see ADR-0044's storage rationale).
   */
  private async raiseInterrupt(
    context: StepExecutionContext,
    type: string,
    payload: Record<string, any>,
  ): Promise<any> {
    const conversation = await this.aiConversationRepository.findById(
      context.conversationId,
    );
    const existing = conversation?.metadata?.interrupt;
    if (existing?.type === type && existing?.answer !== undefined) {
      const answer = existing.answer;
      await this.aiConversationRepository.updateOne(context.conversationId, {
        metadata: { ...(conversation.metadata || {}), interrupt: undefined },
      });
      return answer;
    }

    const interruptId = existing?.id ?? randomUUID();
    if (!existing) {
      await this.aiConversationRepository.updateOne(context.conversationId, {
        metadata: {
          ...(conversation.metadata || {}),
          interrupt: {
            id: interruptId,
            type,
            payload,
            createdAt: new Date().toISOString(),
          },
        },
      });
      this.aiUtilService.sendSSE(context.response, "interrupt", {
        interruptId,
        type,
        payload,
      });
    }

    const deadline = Date.now() + this.INTERRUPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.INTERRUPT_POLL_INTERVAL_MS),
      );
      const polled = await this.aiConversationRepository.findById(
        context.conversationId,
      );
      const interrupt = polled?.metadata?.interrupt;
      if (interrupt?.id === interruptId && interrupt?.answer !== undefined) {
        await this.aiConversationRepository.updateOne(
          context.conversationId,
          { metadata: { ...(polled.metadata || {}), interrupt: undefined } },
        );
        return interrupt.answer;
      }
    }
    // Clear the stale record before throwing — otherwise a retry of this same step (or a
    // later step's own interrupt) finds `existing` still set, skips re-sending the SSE
    // event (silent hang for a reconnected/late client), and a stale interruptId could
    // still 409-match a genuinely new pause. Re-read rather than reusing the pre-poll
    // `conversation` so an unrelated metadata write during the 30-minute wait isn't clobbered.
    const latest = await this.aiConversationRepository.findById(
      context.conversationId,
    );
    await this.aiConversationRepository.updateOne(context.conversationId, {
      metadata: { ...(latest?.metadata || {}), interrupt: undefined },
    });
    throw new Error(`Timed out waiting for an answer to a "${type}" interrupt.`);
  }

  /**
   * ADR-0044: the side channel `raiseInterrupt`'s poll picks up on its next tick. 409s on a
   * stale or repeated answer (no live interrupt, or a different one) — the same shape
   * `confirmStep` uses to reject a step that isn't `awaiting_confirmation`.
   */
  async interruptAnswer(
    conversationId: string,
    interruptId: string,
    answer: any,
    userId: string,
  ): Promise<any> {
    if (!conversationId || !interruptId || answer === undefined) {
      throw new BadRequestException(
        "conversationId, interruptId and answer are required",
      );
    }
    await this.loadConversationOfType(conversationId, "generate", userId);
    const conversation =
      await this.aiConversationRepository.findById(conversationId);
    const interrupt = conversation?.metadata?.interrupt;
    if (!interrupt || interrupt.id !== interruptId) {
      throw new ConflictException(
        "This interrupt is no longer awaiting an answer",
      );
    }
    await this.aiConversationRepository.updateOne(conversationId, {
      metadata: {
        ...(conversation.metadata || {}),
        interrupt: { ...interrupt, answer, answeredAt: new Date().toISOString() },
      },
    });
    return { answered: interruptId };
  }

  async executeCreateTableStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    // Ticket #77 / ADR-0042: a plan-time name collision against an external PostgreSQL
    // target is a terminal, retryable-guard-shaped failure decided once in generateStepPlan —
    // this step never had a plannedTable persisted, so it would otherwise fall through to the
    // per-step LLM path below and build against ToolJet DB instead, silently ignoring the
    // collision the plan already found. Thrown here so it surfaces through the normal
    // step-failed SSE/message channel every other retryable guard already uses.
    if (step.props?.collisionError) {
      throw new Error(step.props.collisionError);
    }

    // Ticket #20: a planned table persisted by the planner is the contract — it is created
    // verbatim with no LLM call, so what the pre-approval schema preview showed is exactly
    // what gets created. Steps without a well-formed planned table (plans persisted before
    // #20, or a malformed definition dropped at plan time) fall through to the LLM path.
    if (isWellFormedTableDefinition(step.plannedTable)) {
      const tableParams = this.buildTableParams(step.plannedTable);
      await this.validateForeignKeys(tableParams, context);

      // Ticket #77 / ADR-0042: a CreateTable step whose plan-time resolution picked a
      // connected PostgreSQL source over ToolJet DB. Confirmation gate first, DDL only after.
      if (step.targetDataSourceId) {
        const targetDataSource = context.dataSources.find(
          (source) => source.id === step.targetDataSourceId,
        );
        if (!targetDataSource) {
          throw new Error(
            `This step's target data source (${step.targetDataSourceId}) is no longer connected`,
          );
        }
        await this.awaitExternalTableConfirmation(
          step,
          context,
          targetDataSource,
        );

        const created = await this.agentsService.CreateExternalTable(
          context.organizationId,
          targetDataSource.id,
          tableParams,
        );
        let seed: SeedTableReport | undefined;
        if (isWellFormedSeedRows(step.plannedSeedRows)) {
          seed = await this.agentsService.SeedExternalTable(
            context.organizationId,
            targetDataSource.id,
            created.table_name,
            step.plannedSeedRows,
          );
        }
        return {
          content: {
            ...created,
            columns: tableParams.columns,
            targetDataSourceId: targetDataSource.id,
            ...(seed && { seed }),
          },
          identifier: created.table_name,
          props: tableParams,
        };
      }

      const created = await this.agentsService.CreateTable(
        context.organizationId,
        tableParams,
      );
      // Ticket #48: seed rows the planner proposed (and the preview showed) are inserted
      // here, right after the table exists — same deterministic, no-LLM contract as the
      // table itself. Ticket #62: rows run as individual queries with a per-row report
      // (counts + failures) that rides into the Artifact so the run UI can show what
      // landed. Only a total seed failure throws into the retry loop.
      let seed: SeedTableReport | undefined;
      if (isWellFormedSeedRows(step.plannedSeedRows)) {
        const primaryKeyColumns = step.plannedTable.columns
          .filter((column: any) => column.is_primary_key)
          .map((column: any) => column.column_name);
        seed = await this.agentsService.SeedTable(
          context.organizationId,
          created.id,
          primaryKeyColumns,
          step.plannedSeedRows,
        );
      }
      return {
        content: {
          ...created,
          columns: tableParams.columns,
          ...(seed && { seed }),
        },
        identifier: created.table_name,
        props: tableParams,
      };
    }

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: CREATE_TABLE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: this.buildStepContextLines(step, context, previousError),
          },
        ],
      },
      "executeTableStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-create-table",
      {
        ...prompt,
        tools: { createTable: createTableTool },
        toolChoice: { type: "tool", toolName: "createTable" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "createTable") {
      throw new Error("The assistant did not produce a table definition");
    }

    const args = call.args as TableDefinition;
    const tableParams = this.buildTableParams(args);
    await this.validateForeignKeys(tableParams, context);

    const created = await this.agentsService.CreateTable(
      context.organizationId,
      tableParams,
    );

    // `created` only carries { id, table_name } (TooljetDbTableOperationsService's return) —
    // merging in the real columns here is what lets later steps (CreateQuery, and a Form
    // step's field generation) see this table's actual schema via context.priorResults,
    // not just its id/name.
    return {
      content: { ...created, columns: tableParams.columns },
      identifier: created.table_name,
      props: tableParams,
    };
  }

  /**
   * Ticket #111 / ADR-0041: executes an UpdateTable step. The tool call carries a
   * full replace of the table's column definition; the current schema is fetched here
   * (AgentsService.ViewTable), the diff is computed deterministically
   * (diffTableColumns), and the resulting alter entries run through the existing
   * 'edit_table' action — no hand-built SQL. The LLM is never trusted with the
   * transition itself, only with the desired end state.
   *
   * A planned table on the step (same persisted-preview contract as CreateTable,
   * ticket #20) is used verbatim; note the planned path carries no renames — a rename
   * must come through the tool call (or be absent, in which case the plan's omission
   * of the old column is a data-losing drop the user previewed and approved).
   */
  private async executeUpdateTableStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    let desired: TableDefinition & { renames?: Record<string, string> };
    if (isWellFormedTableDefinition(step.plannedTable)) {
      desired = step.plannedTable;
    } else {
      const current = await this.fetchCurrentTableSchema(step, context);
      const prompt = await this.budgetPromptForOrg(
        context.organizationId,
        {
          system: UPDATE_TABLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [
                this.buildStepContextLines(step, context, previousError),
                `The table's current columns (JSON):\n${JSON.stringify(current.columns, null, 2)}`,
              ].join("\n\n"),
            },
          ],
        },
        "executeTableStep",
      );
      const result = await this.aiUtilService.AIGatewayGenerate(
        "openai",
        "approve-prd-update-table",
        {
          ...prompt,
          tools: { updateTable: updateTableTool },
          toolChoice: { type: "tool", toolName: "updateTable" },
        },
        context.organizationId,
      );

      const call = result?.toolCalls?.[0];
      if (!call || call.toolName !== "updateTable") {
        throw new Error("The assistant did not produce a table update");
      }
      desired = call.args as TableDefinition & {
        renames?: Record<string, string>;
      };
    }

    const validationProblems = validateDesiredColumns(
      desired.columns.map((column) => ({
        column_name: column.column_name,
        data_type: column.data_type,
        constraints_type: {
          is_primary_key: column.is_primary_key,
          is_not_null: column.is_not_null,
          is_unique: column.is_unique,
        },
      })),
    );
    if (validationProblems.length) {
      throw new Error(`Invalid table update: ${validationProblems.join("; ")}`);
    }

    const current = await this.fetchCurrentTableSchema(
      step,
      context,
      desired.table_name,
    );
    // Columns involved in the table's foreign keys (from view_table's own FK listing) —
    // diffTableColumns refuses dropping them (ADR-0041's safety stance).
    const fkColumnNames = new Set<string>(
      (current.foreign_keys ?? []).flatMap(
        (foreignKey: any) => foreignKey?.column_names ?? [],
      ),
    );
    const diff = diffTableColumns(
      current.columns as CurrentTjdbColumn[],
      this.buildTableParams(desired).columns as DesiredTjdbColumn[],
      desired.renames,
      { tableName: desired.table_name, fkColumnNames },
    );
    if (diff.refusals.length) {
      // Not retryable by re-prompting for the same payload — these are structural
      // refusals (primary key / foreign-key drops). Surfaced as the step error.
      throw new Error(`update_table refused: ${diff.refusals.join("; ")}`);
    }
    if (diff.noOp) {
      return {
        content: {
          table_name: desired.table_name,
          no_op: true,
          columns: desired.columns,
        },
        identifier: desired.table_name,
        props: { table_name: desired.table_name, columns: desired.columns },
      };
    }

    await this.agentsService.UpdateTable(context.organizationId, {
      table_name: desired.table_name,
      columns: diff.entries,
    });

    return {
      content: {
        table_name: desired.table_name,
        columns: desired.columns,
        ...(desired.renames && { renames: desired.renames }),
      },
      identifier: desired.table_name,
      props: { table_name: desired.table_name, columns: diff.entries },
    };
  }

  /**
   * Fetches a table's current schema for an UpdateTable step. `tableNameHint` defaults to
   * the planned table's name — the planned path needs the schema of the table it is about
   * to replace, the LLM path also shows it to the model before it answers.
   */
  private async fetchCurrentTableSchema(
    step: Step,
    context: StepExecutionContext,
    tableNameHint?: string,
  ) {
    const tableName = tableNameHint ?? step.plannedTable?.table_name;
    if (!tableName || typeof tableName !== "string") {
      throw new Error(
        "UpdateTable step does not name an existing table to update",
      );
    }
    return this.agentsService.ViewTable(context.organizationId, tableName);
  }

  private async executeComponentStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: CREATE_COMPONENT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: this.buildStepContextLines(step, context, previousError),
          },
        ],
      },
      "executeComponentStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-create-component",
      {
        ...prompt,
        tools: { createComponent: createComponentTool },
        toolChoice: { type: "tool", toolName: "createComponent" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "createComponent") {
      throw new Error("The assistant did not produce a component definition");
    }

    const { type, ...props } = call.args as {
      type: string;
      [key: string]: any;
    };
    if (!(SUPPORTED_COMPONENT_TYPES as readonly string[]).includes(type)) {
      // Retryable, unlike an unsupported Step type: the model chooses `type` per attempt.
      throw new Error(
        `Unsupported component type "${type}" — supported types are: ${SUPPORTED_COMPONENT_TYPES.join(", ")}`,
      );
    }

    // Every widget-on-a-page type only actually works if pageId is real — the tool schema
    // can't enforce that (it's a free-form string), so it's checked here against what this
    // plan has actually built so far. Without this, a hallucinated pageId would either fail
    // at the DB (a real FK) or, worse for Table/Form, silently persist a widget bound to
    // nothing rather than failing loud — retryable, same reasoning as the type check above.
    // A Page artifact is distinguished from a widget artifact by NOT having its own `pageId`
    // (every widget's content does, via createWidgetComponent's return shape).
    if ((PAGE_WIDGET_TYPES as readonly string[]).includes(type)) {
      const pageExists = context.priorResults.some(
        (result) =>
          result.type === "CreateComponent" &&
          result.artifact.content?.id === props.pageId &&
          result.artifact.content?.pageId === undefined,
      );
      if (!pageExists) {
        throw new Error(
          `pageId "${props.pageId}" does not match any Page created earlier in this plan`,
        );
      }
    }

    // Create-time nesting: parentComponentId, when given, must reference a Container, Form,
    // Listview or ModalV2/Tabs slot already created earlier in THIS plan on the SAME page.
    // Unlike ModalV2's fixed "-header"/"-footer" suffixes, a bare match is tried first
    // (rather than regexing off a trailing "-segment") because every id here is a UUID
    // already full of dashes — splitting on "-" blind would mangle it. Only once no widget's
    // id equals rawParentId outright do we look for one that rawParentId extends by exactly
    // "-<suffix>", and interpret that suffix per the found parent's own type (ModalV2 ADR-0043
    // follow-up; Tabs/Listview this pass — see docs/adr/0043, "Follow-up: Tabs pane nesting").
    if (props.parentComponentId) {
      const rawParentId: string = props.parentComponentId;

      const widgetsOnPage = context.priorResults.filter(
        (result) =>
          result.type === "CreateComponent" &&
          result.artifact.content?.pageId === props.pageId,
      );

      const bareMatch = widgetsOnPage.find(
        (result) => result.artifact.content?.id === rawParentId,
      );
      if (bareMatch) {
        const parentType = bareMatch.artifact.content?.type;
        if (parentType === "Tabs") {
          throw new Error(
            `parentComponentId "${rawParentId}" refers to a Tabs bar directly — target one of its panes instead, e.g. "${rawParentId}-0"`,
          );
        }
        if (
          parentType !== "Container" &&
          parentType !== "Form" &&
          parentType !== "Listview" &&
          parentType !== "ModalV2"
        ) {
          throw new Error(
            `parentComponentId "${rawParentId}" refers to a ${parentType}, which cannot hold nested children — only Container, Form, Listview, ModalV2 and Tabs (via a pane suffix) can`,
          );
        }
        // Container/Form/Listview body, or ModalV2's body slot — all valid bare.
      } else {
        const slotParent = widgetsOnPage.find(
          (result) =>
            typeof result.artifact.content?.id === "string" &&
            rawParentId.startsWith(`${result.artifact.content.id}-`),
        );
        if (!slotParent) {
          throw new Error(
            `parentComponentId "${rawParentId}" does not match any Container, Form, Listview, ModalV2 or Tabs created earlier in this plan on the same page`,
          );
        }
        const baseParentId: string = slotParent.artifact.content.id;
        const suffix = rawParentId.slice(baseParentId.length + 1);
        const parentType = slotParent.artifact.content?.type;
        if (parentType === "ModalV2") {
          if (suffix !== "header" && suffix !== "footer") {
            throw new Error(
              `parentComponentId "${rawParentId}" refers to a ModalV2 slot suffix "${suffix}", but only "-header" and "-footer" are valid (bare id for the body)`,
            );
          }
        } else if (parentType === "Tabs") {
          const tabsCount: number =
            slotParent.artifact.content?.tabsCount ?? 3;
          const tabIndex = Number(suffix);
          if (
            !/^\d+$/.test(suffix) ||
            tabIndex < 0 ||
            tabIndex >= tabsCount
          ) {
            throw new Error(
              `parentComponentId "${rawParentId}" refers to tab index "${suffix}", but this Tabs bar only has tabs 0-${tabsCount - 1}`,
            );
          }
        } else {
          throw new Error(
            `parentComponentId "${rawParentId}" refers to a ${parentType}, which has no addressable slots — only ModalV2 ("-header"/"-footer") and Tabs ("-<tabIndex>") do`,
          );
        }
      }
    }

    if (type === "Table") {
      const queryExists = context.priorResults.some(
        (result) =>
          result.type === "CreateQuery" &&
          result.artifact.content?.name === props.queryName,
      );
      if (!queryExists) {
        throw new Error(
          `queryName "${props.queryName}" does not match any query created earlier in this plan`,
        );
      }
    }

    if (type === "Form") {
      const tableResult = context.priorResults.find(
        (result) =>
          result.type === "CreateTable" &&
          result.artifact.content?.id === props.tableId,
      );
      if (!tableResult) {
        throw new Error(
          `tableId "${props.tableId}" does not match any table created earlier in this plan`,
        );
      }
      // AgentsService.createFormComponent needs the table's real columns (to build the
      // form's fields) — only available from the CreateTable step's Artifact content.
      props.columns = tableResult.artifact.content.columns;

      // An edit-mode Form binds its fields and its update_rows identity filter to another
      // Table widget's selectedRow, so that Table must actually exist in this plan AND be
      // bound (via the query it displays) to the same underlying ToolJet DB table this
      // form edits. Both are retryable failures — the model picks the name/id per attempt,
      // and the error names what it was actually offered so the next attempt can correct.
      if (props.mode === "edit") {
        if (!props.tableName) {
          throw new Error(
            "An edit-mode Form must reference a Table widget (tableName) to bind its selectedRow to",
          );
        }
        const tableWidget = context.priorResults.find(
          (result) =>
            result.type === "CreateComponent" &&
            result.artifact.content?.type === "Table" &&
            result.artifact.content?.name === props.tableName,
        );
        if (!tableWidget) {
          throw new Error(
            `tableName "${props.tableName}" does not match any Table widget created earlier in this plan`,
          );
        }
        const boundQuery = context.priorResults.find(
          (result) =>
            result.type === "CreateQuery" &&
            result.artifact.content?.name ===
              tableWidget.artifact.content?.queryName,
        );
        if (
          !boundQuery ||
          boundQuery.artifact.content?.options?.table_id !== props.tableId
        ) {
          throw new Error(
            `Table "${props.tableName}" is not bound to the same ToolJet DB table (${props.tableId}) this edit-mode form edits`,
          );
        }
      }
    }

    const created = await this.agentsService.CreateComponent(
      context.appVersionId,
      context.organizationId,
      type,
      props,
    );

    return {
      content: created,
      identifier: created.id,
      props: { type, ...props },
    };
  }

  /**
   * UpdateComponent (ticket #66): the target `componentId` the model returns is checked
   * against the real component index before anything is merged — a hallucinated id must
   * fail loud and retryable (same reasoning as executeComponentStep's pageId check), never
   * silently create a new component under that id.
   */
  async executeUpdateComponentStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const componentIndex = await this.appInventoryService.renderComponentIndex(
      context.appVersionId,
    );
    const stepContext = `${this.buildStepContextLines(step, context, previousError)}\n\n${componentIndex}`;

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: UPDATE_COMPONENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: stepContext }],
      },
      "executeUpdateComponentStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-update-component",
      {
        ...prompt,
        tools: { updateComponent: updateComponentTool },
        toolChoice: { type: "tool", toolName: "updateComponent" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "updateComponent") {
      throw new Error("The assistant did not produce a component update");
    }

    const { componentId, properties, styles } = call.args as {
      componentId: string;
      properties?: Record<string, unknown>;
      styles?: Record<string, unknown>;
    };

    // Retryable: componentId is a free-form string the tool schema can't constrain, so a
    // hallucinated one is fed back for the next attempt exactly like pageId/queryName above.
    if (!componentIndex.includes(`(id: ${componentId},`)) {
      throw new Error(
        `componentId "${componentId}" does not match any existing component in this app`,
      );
    }

    const updated = await this.agentsService.UpdateComponent(
      context.appVersionId,
      context.organizationId,
      componentId,
      { properties, styles },
    );

    return {
      content: updated,
      identifier: updated.id,
      props: { componentId, properties, styles },
    };
  }

  private async executeDeleteComponentStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const componentIndex = await this.appInventoryService.renderComponentIndex(
      context.appVersionId,
    );
    const stepContext = `${this.buildStepContextLines(step, context, previousError)}\n\n${componentIndex}`;

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: DELETE_COMPONENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: stepContext }],
      },
      "executeDeleteComponentStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-delete-component",
      {
        ...prompt,
        tools: { deleteComponent: deleteComponentTool },
        toolChoice: { type: "tool", toolName: "deleteComponent" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "deleteComponent") {
      throw new Error("The assistant did not produce a component to delete");
    }

    const { componentId } = call.args as { componentId: string };
    if (!componentIndex.includes(`(id: ${componentId},`)) {
      throw new Error(
        `componentId "${componentId}" does not match any existing component in this app`,
      );
    }

    const snapshot = await this.agentsService.DeleteComponent(
      context.appVersionId,
      componentId,
    );

    return {
      content: snapshot,
      identifier: snapshot.id,
      props: { componentId },
    };
  }

  /**
   * MoveComponent (ADR-0043 follow-up): grounds both componentId and newParentComponentId
   * against the live component index the same way UpdateComponent/DeleteComponent do — the
   * target and the new parent can be anything already in the app, not just this plan's own
   * priorResults, unlike create-time parentComponentId nesting (which only reaches
   * components this same plan created). Cycle safety and the actual reparent live in
   * AgentsService.MoveComponent (componentsService.componentLayoutChange's own
   * assertNoParentCycle) — this method only checks that both ids are real.
   */
  private async executeMoveComponentStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const componentIndex = await this.appInventoryService.renderComponentIndex(
      context.appVersionId,
    );
    const stepContext = `${this.buildStepContextLines(step, context, previousError)}\n\n${componentIndex}`;

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: MOVE_COMPONENT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: stepContext }],
      },
      "executeMoveComponentStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-move-component",
      {
        ...prompt,
        tools: { moveComponent: moveComponentTool },
        toolChoice: { type: "tool", toolName: "moveComponent" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "moveComponent") {
      throw new Error("The assistant did not produce a component to move");
    }

    const { componentId, newParentComponentId } = call.args as {
      componentId: string;
      newParentComponentId?: string;
    };
    if (!componentIndex.includes(`(id: ${componentId},`)) {
      throw new Error(
        `componentId "${componentId}" does not match any existing component in this app`,
      );
    }
    if (
      newParentComponentId &&
      !componentIndex.includes(`(id: ${newParentComponentId},`)
    ) {
      throw new Error(
        `newParentComponentId "${newParentComponentId}" does not match any existing component in this app`,
      );
    }

    const snapshot = await this.agentsService.MoveComponent(
      context.appVersionId,
      componentId,
      newParentComponentId,
    );

    return {
      content: snapshot,
      identifier: snapshot.id,
      props: { componentId, newParentComponentId },
    };
  }

  private async executeDeleteQueryStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const existingQueries = context.priorResults.filter(
      (result) => result.type === "CreateQuery",
    );
    if (!existingQueries.length) {
      throw new Error(
        "There is no query to delete — a DeleteQuery step needs a CreateQuery step before it",
      );
    }

    const stepContext = [
      this.buildStepContextLines(step, context, previousError),
      `Existing queries (delete exactly one of these, by name):\n${existingQueries
        .map(
          (result) =>
            `- ${result.artifact.content.name} (id ${result.artifact.content.id})`,
        )
        .join("\n")}`,
    ].join("\n\n");

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: DELETE_QUERY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: stepContext }],
      },
      "executeDeleteQueryStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-delete-query",
      {
        ...prompt,
        tools: { deleteQuery: deleteQueryTool },
        toolChoice: { type: "tool", toolName: "deleteQuery" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "deleteQuery") {
      throw new Error("The assistant did not produce a query to delete");
    }

    const { queryName } = call.args as { queryName: string };
    const existing = existingQueries.find(
      (entry) => entry.artifact.content?.name === queryName,
    );
    if (!existing) {
      throw new Error(
        `queryName "${queryName}" does not match any query created earlier in this plan. Available: ${existingQueries
          .map((entry) => entry.artifact.content?.name)
          .join(", ")}`,
      );
    }

    const snapshot = await this.agentsService.DeleteQuery(
      existing.artifact.content.id,
    );

    return {
      content: snapshot,
      identifier: snapshot.name,
      props: { queryName },
    };
  }

  private async executeQueryStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const stepContext = this.buildStepContextLines(
      step,
      context,
      previousError,
    );

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: CREATE_QUERY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: withConnectedDataSources(stepContext, context.dataSources),
          },
        ],
      },
      "executeQueryStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-create-query",
      {
        ...prompt,
        tools: { createQuery: createQueryTool },
        toolChoice: { type: "tool", toolName: "createQuery" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "createQuery") {
      throw new Error("The assistant did not produce a query definition");
    }

    const args = call.args as {
      source?: string;
      name: string;
      table_id?: string;
      data_source_id?: string;
      sql?: string;
      method?: string;
      url?: string;
      headers?: Array<{ key: string; value: string }>;
      params?: Array<{ key: string; value: string }>;
      body?: string;
      operation?: string;
      options?: Array<{ key: string; value: string }>;
    };
    // Absent `source` lands on tooljetdb (see buildTooljetDbQueryProps) — a plan written
    // without one is a ToolJet DB plan, exactly as it always was.
    let props: any;
    switch (args.source) {
      case "sql":
        props = await this.buildExternalQueryProps(args, context);
        break;
      case "restapi":
        props = await this.buildRestApiQueryProps(args, context);
        break;
      case "plugin":
        props = await this.buildPluginQueryProps(args, context);
        break;
      default:
        props = this.buildTooljetDbQueryProps(args);
        break;
    }

    const created = await this.agentsService.CreateQuery(
      context.appVersionId,
      context.organizationId,
      props,
    );

    return { content: created, identifier: created.name, props };
  }

  /**
   * Ticket #67: attaches one event to a component/query this plan created, validated
   * against the machine event catalog. An existing handler on the same target with the
   * same eventId is updated in place rather than duplicated (the acceptance criterion
   * "changes/adds an event without duplicates"). The artifact records the previous body
   * of updated events and the ids of created ones, so rewind (undoGenerateEvent) can
   * restore both.
   */
  private async executeEventStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const components = context.priorResults.filter(
      (result) =>
        result.type === "CreateComponent" &&
        result.artifact.content?.pageId !== undefined,
    );
    const queries = context.priorResults.filter(
      (result) => result.type === "CreateQuery",
    );

    const targets = [
      ...components.map((result) => ({
        name: result.artifact.content.name,
        id: result.artifact.content.id,
        componentType: result.artifact.content.type,
      })),
      ...queries.map((result) => ({
        name: result.artifact.content.name,
        id: result.artifact.content.id,
        componentType: null,
      })),
    ];
    if (!targets.length) {
      throw new Error(
        "There is no component or query to attach an event to — a GenerateEvent step needs a CreateComponent or CreateQuery step before it",
      );
    }

    const stepContext = [
      this.buildStepContextLines(step, context, previousError),
      `Attachable targets (use the exact name):\n${targets
        .map(
          (target) =>
            `- ${target.name} (${target.componentType ? `${target.componentType}, id ${target.id}` : `data query, id ${target.id}`})`,
        )
        .join("\n")}`,
    ].join("\n\n");

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: `${GENERATE_EVENT_SYSTEM_PROMPT}\n\n${renderEventCatalogForPrompt()}`,
        messages: [{ role: "user", content: stepContext }],
      },
      "executeEventStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-generate-event",
      {
        ...prompt,
        tools: { generateEvent: generateEventTool },
        toolChoice: { type: "tool", toolName: "generateEvent" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "generateEvent") {
      throw new Error("The assistant did not produce an event definition");
    }

    const args = call.args as {
      targetName: string;
      eventId: string;
      actionId: string;
      params?: Record<string, any>;
    };
    const target = targets.find((entry) => entry.name === args.targetName);
    if (!target) {
      throw new Error(
        `targetName "${args.targetName}" does not match any component or query in this plan. Available: ${targets
          .map((entry) => entry.name)
          .join(", ")}`,
      );
    }
    const targetType = target.componentType ? "component" : "data_query";

    const body = validateEventBody(
      {
        eventId: normalizeEventId(args.eventId),
        actionId: args.actionId,
        ...(args.params || {}),
      },
      targetType,
      target.componentType ?? undefined,
    );

    const existingEvents = await this.agentsService.FindEventsBySource(
      target.id,
    );
    const sameEvent = existingEvents.find(
      (event) => event?.event?.eventId === body.eventId,
    );

    if (sameEvent) {
      await this.agentsService.UpdateEventBody(
        context.appVersionId,
        sameEvent.id,
        body,
      );
      return {
        content: {
          updated: [
            {
              id: sameEvent.id,
              name: sameEvent.name,
              previousEvent: sameEvent.event,
            },
          ],
          targetName: target.name,
          eventId: body.eventId,
        },
        identifier: `${target.name}.${body.eventId}`,
        props: { targetName: target.name, ...body },
      };
    }

    const created = await this.agentsService.CreateEvent(context.appVersionId, {
      name: body.eventId,
      event: body,
      eventType: targetType,
      attachedTo: target.id,
      index: existingEvents.length,
    });
    return {
      content: {
        created: [{ id: created.id, name: created.name, sourceId: target.id }],
        targetName: target.name,
        eventId: body.eventId,
      },
      identifier: `${target.name}.${body.eventId}`,
      props: { targetName: target.name, ...body },
    };
  }

  /**
   * Ticket #67: a diff-update of a query this plan created. The LLM returns only the
   * changed option keys; mergeQueryUpdate merges them over the query's current options
   * (untouched settings survive verbatim) and validateMergedQueryOptions re-runs the
   * read-only SQL check on the merged result. name/dataSourceId are not part of the tool
   * schema at all — a rename or data-source switch is out of this step's contract. The
   * artifact carries previousOptions so rewind (undoUpdateQuery) restores the original.
   */
  private async executeUpdateQueryStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string,
  ): Promise<{ content: any; identifier: string; props: any }> {
    const existingQueries = context.priorResults.filter(
      (result) => result.type === "CreateQuery",
    );
    if (!existingQueries.length) {
      throw new Error(
        "There is no query to update — an UpdateQuery step needs a CreateQuery step before it",
      );
    }

    const stepContext = [
      this.buildStepContextLines(step, context, previousError),
      `Existing queries (update exactly one of these, by name):\n${existingQueries
        .map(
          (result) =>
            `- ${result.artifact.content.name} (id ${result.artifact.content.id}), current options: ${JSON.stringify(result.artifact.content.options)}`,
        )
        .join("\n")}`,
    ].join("\n\n");

    const prompt = await this.budgetPromptForOrg(
      context.organizationId,
      {
        system: UPDATE_QUERY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: stepContext }],
      },
      "executeUpdateQueryStep",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "approve-prd-update-query",
      {
        ...prompt,
        tools: { updateQuery: updateQueryTool },
        toolChoice: { type: "tool", toolName: "updateQuery" },
      },
      context.organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "updateQuery") {
      throw new Error("The assistant did not produce a query update");
    }

    const args = call.args as {
      queryName: string;
      options: Record<string, any>;
    };
    const existing = existingQueries.find(
      (entry) => entry.artifact.content?.name === args.queryName,
    );
    if (!existing) {
      throw new Error(
        `queryName "${args.queryName}" does not match any query created earlier in this plan. Available: ${existingQueries
          .map((entry) => entry.artifact.content?.name)
          .join(", ")}`,
      );
    }

    const previousOptions = existing.artifact.content.options ?? {};
    const mergedOptions = validateMergedQueryOptions(
      mergeQueryUpdate(previousOptions, args.options),
    );

    await this.agentsService.UpdateQuery(
      existing.artifact.content.id,
      mergedOptions,
    );

    return {
      content: {
        queryId: existing.artifact.content.id,
        name: existing.artifact.content.name,
        previousOptions,
        options: mergedOptions,
      },
      identifier: existing.artifact.content.name,
      props: { queryName: args.queryName, options: args.options },
    };
  }

  /**
   * The default branch, and the only one that existed before ADR-0019 — which is why an
   * absent `source` lands here rather than being rejected: a plan the model writes without
   * naming a source is a ToolJet DB plan, exactly as it always was.
   */
  private buildTooljetDbQueryProps(args: { name: string; table_id?: string }) {
    return {
      name: args.name,
      options: {
        operation: "list_rows",
        table_id: args.table_id,
        list_rows: { limit: 100 },
      },
    };
  }

  /**
   * A query against a connected source, validated the same way `pageId` and `queryName` are
   * in executeComponentStep: the tool schema can only ask for a string, so an id the model
   * invented has to be caught here. Failing is retryable — the model picks the id per attempt,
   * and the error names what it was actually offered so the next attempt can correct itself.
   *
   * There is no equivalent check on the SQL itself. Nothing in this flow runs the query, so a
   * table name that doesn't exist would not surface here either way; showing the model the
   * source's real tables (renderConnectedDataSources) is what keeps the statement honest.
   */
  /**
   * Resolves a model-supplied `data_source_id` against the same connected-sources list the
   * prompt showed it, the same way `pageId`/`queryName` are resolved elsewhere in this flow:
   * the tool schema can only ask for a string, so an id the model invented has to be caught
   * here, and failing is retryable — the error names what was actually offered so the next
   * attempt can correct itself. Shared by every external-source query branch (sql, restapi)
   * so the hallucinated-id retry text is identical regardless of which branch was picked.
   */
  private async resolveExternalDataSource(
    dataSourceId: string | undefined,
    context: StepExecutionContext,
  ): Promise<QueryableDataSource> {
    // ADR-0044: a missing id with more than one connected source is genuine ambiguity, not
    // a model mistake — the prompt's connected-sources block cannot force a correct guess,
    // so this asks the user instead of retrying the model against the same information.
    // An id that IS given but doesn't match stays a retryable model error, unchanged below.
    if (!dataSourceId && context.dataSources.length > 1) {
      const answer = await this.raiseInterrupt(context, "select_datasource", {
        candidates: context.dataSources.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
        })),
      });
      const chosen = context.dataSources.find(
        (candidate) => candidate.id === answer?.dataSourceId,
      );
      if (!chosen) {
        throw new Error(
          `Interrupt answer "${answer?.dataSourceId}" does not match any connected data source.`,
        );
      }
      return chosen;
    }

    const dataSource = context.dataSources.find(
      (candidate) => candidate.id === dataSourceId,
    );
    if (!dataSource) {
      const available = context.dataSources.length
        ? context.dataSources
            .map((candidate) => `${candidate.name} (${candidate.id})`)
            .join(", ")
        : "none — this app has no connected data source, so the query must target ToolJet DB";
      throw new Error(
        `data_source_id "${dataSourceId}" does not match any connected data source. Available: ${available}`,
      );
    }
    return dataSource;
  }

  private async buildExternalQueryProps(
    args: { name: string; data_source_id?: string; sql?: string },
    context: StepExecutionContext,
  ) {
    if (!args.sql?.trim()) {
      throw new Error(
        "An external data source query needs a SQL statement, but none was given",
      );
    }
    if (!isSingleReadOnlyStatement(args.sql)) {
      throw new Error(
        `The query must be a single read-only SELECT statement against ${"`"}${args.data_source_id}${"`"}, but it was: ${args.sql}`,
      );
    }

    const dataSource = await this.resolveExternalDataSource(
      args.data_source_id,
      context,
    );

    return {
      name: args.name,
      dataSourceId: dataSource.id,
      options: { mode: "sql", query: args.sql },
    };
  }

  /**
   * A query against a connected REST API data source. Mirrors the option shape the restapi
   * plugin's runtime actually reads (`plugins/packages/restapi/lib/index.ts`'s `run()` /
   * the query editor's `Restapi` component defaults) — `headers`/`url_params`/`body` as
   * key-value pair arrays, `body_toggle` gating whether `body` is even sent — so a query
   * this step creates runs identically to one a user built by hand.
   */
  private async buildRestApiQueryProps(
    args: {
      name: string;
      data_source_id?: string;
      method?: string;
      url?: string;
      headers?: Array<{ key: string; value: string }>;
      params?: Array<{ key: string; value: string }>;
      body?: string;
    },
    context: StepExecutionContext,
  ) {
    if (!args.url?.trim()) {
      throw new Error(
        "A REST API query needs a request path/URL, but none was given",
      );
    }

    const dataSource = await this.resolveExternalDataSource(
      args.data_source_id,
      context,
    );

    const toPairs = (entries?: Array<{ key: string; value: string }>) =>
      (entries ?? []).map(({ key, value }) => [key, value]);

    return {
      name: args.name,
      dataSourceId: dataSource.id,
      options: {
        method: args.method ?? "get",
        url: args.url,
        url_params: toPairs(args.params),
        headers: toPairs(args.headers),
        body_toggle: Boolean(args.body?.trim()),
        raw_body: args.body ?? null,
        json_body: null,
        body: [],
        cookies: [],
      },
    };
  }

  /**
   * A query against a connected plugin data source (increment 5's `plugin` branch, initially
   * deferred — see ADR-0045, `docs/adr/0045-plugin-query-branch.md`). Unlike
   * restapi/sql, there is no single fixed option shape across plugins: each one's runtime
   * `run()` reads whatever flat fields its own `operations.json` describes for the chosen
   * operation (Slack's `send_message` wants `channel`/`message`; Airtable's `create_record`
   * wants different fields entirely) — the same "options stored flat, unwrapped, exactly as
   * `run()` reads them" convention `buildRestApiQueryProps` already established, just with a
   * `plugin`-supplied key set instead of a fixed one.
   */
  private async buildPluginQueryProps(
    args: {
      name: string;
      data_source_id?: string;
      operation?: string;
      options?: Array<{ key: string; value: string }>;
    },
    context: StepExecutionContext,
  ) {
    if (!args.operation?.trim()) {
      throw new Error(
        "A plugin query needs an operation, but none was given",
      );
    }

    const dataSource = await this.resolveExternalDataSource(
      args.data_source_id,
      context,
    );

    const validOperations = dataSource.operations ?? [];
    if (!validOperations.some((op) => op.value === args.operation)) {
      const available = validOperations.length
        ? validOperations.map((op) => op.value).join(", ")
        : "none — this source has no usable operations";
      throw new Error(
        `operation "${args.operation}" is not one of ${dataSource.name}'s operations. Available: ${available}`,
      );
    }

    const fields = Object.fromEntries(
      (args.options ?? []).map(({ key, value }) => [key, value]),
    );

    return {
      name: args.name,
      dataSourceId: dataSource.id,
      options: { operation: args.operation, ...fields },
    };
  }

  /**
   * The @-mention contract (ticket #27): a chat message may name specific pages/components/
   * queries via the composer's @-autocomplete, and the frontend sends those mentions as a
   * structured `references` array ({type, id, name, ...} snapshots of live builder state).
   * This renders them into a system-context block so the model acts on "this specific
   * component" (a real id) rather than guessing from a name in prose — the same principle as
   * StepExecutionContext's prior-artifact serialization. Unknown/blank references are
   * dropped; null when nothing usable remains.
   */
  buildMentionedResourcesContext(references: any): string | null {
    if (!Array.isArray(references) || references.length === 0) return null;
    // Client-controlled strings go into a system-role message, so they get flattened (no
    // newlines — a forged "- @x" line would read as a resource), truncated, and capped in
    // count. Ids are advisory context: the model treats them as pointers, and every real
    // execution still re-resolves names/ids against the database.
    const flatten = (value: any, maxLength: number) =>
      typeof value === "string"
        ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
        : "";
    const lines = references
      .slice(0, 20)
      .filter(
        (reference) =>
          reference &&
          typeof reference === "object" &&
          ["page", "component", "query"].includes(reference.type) &&
          flatten(reference.id, 64) &&
          flatten(reference.name, 100),
      )
      .map((reference) => {
        const id = flatten(reference.id, 64);
        const name = flatten(reference.name, 100);
        const details: string[] = [];
        if (reference.type === "component") {
          const widgetType = flatten(reference.widgetType, 60);
          const pageName = flatten(reference.pageName, 100);
          if (widgetType) details.push(`${widgetType} widget`);
          if (pageName) details.push(`on page "${pageName}"`);
        } else if (reference.type === "query") {
          const kind = flatten(reference.kind, 60);
          if (kind) details.push(`kind: ${kind}`);
        }
        const suffix = details.length ? ` (${details.join(", ")})` : "";
        return `- @${name} — ${reference.type}${suffix}, id: ${id}`;
      });
    if (!lines.length) return null;
    return [
      "The user @-mentioned resources in this message. Each @name below refers to exactly this object:",
      ...lines,
    ].join("\n");
  }

  /**
   * Shared PRD-conversation message shape both `sendUserMessage` and `regenerateAiMessage`
   * feed to the LLM: the system prompt, `priorMessages` mapped to role/content, and an
   * optional trailing user turn (sendUserMessage's new message — regenerateAiMessage has
   * none, since the user turn it's replying to is already the last entry in priorMessages).
   */
  private buildPrdMessages(
    priorMessages: AiConversationMessage[],
    trailingUserContent?: string,
    referencesContext?: string | null,
  ) {
    return [
      { role: "system", content: PRD_SYSTEM_PROMPT },
      ...(referencesContext
        ? [{ role: "system", content: referencesContext }]
        : []),
      ...priorMessages.map((message) => ({
        role: message.messageType === "user" ? "user" : "assistant",
        content: message.content,
      })),
      ...(trailingUserContent
        ? [{ role: "user", content: trailingUserContent }]
        : []),
    ];
  }

  /**
   * PRD text generation (ticket #91), abstracted behind one async generator so
   * `sendUserMessage` doesn't care which backend produced the tokens.
   *
   * When the Generation engine is configured (`GENERATION_ENGINE_URL` set,
   * ADR-0032), proxies its `POST /generate/prd` SSE stream
   * (GenerationEngineClient, ADR-0027) — forwarding starts as the engine's
   * first `chunk` arrives, no buffering (AC#2). An `error` event from the
   * client (engine unreachable, mid-stream failure, or a stream that ended
   * with neither `done` nor `error` — AC#3) is thrown so it lands in the same
   * catch/`sendSSE(..., 'error', ...)` path the in-process call already uses.
   *
   * Otherwise falls back to the existing in-process `AIGateway` call — this is
   * the deliberate flag-guard from ADR-0036: nothing deploys the engine yet
   * (CONTEXT.md, "not wired into the root build chain"), so a hard switch
   * would break every PRD generation in dev and prod the moment this merges.
   *
   * `abortSignal` is wired to the browser response's `close` event by the
   * caller so a disconnecting client also aborts the upstream engine request,
   * rather than leaving it generating with nowhere to send the result.
   */
  private async *streamPrdText(
    budgetedMessages: Array<{ role: string; content: string }>,
    organizationId: string,
    abortSignal: AbortSignal,
    usageSink?: { usage?: Promise<any> | any },
  ): AsyncGenerator<string> {
    if (this.generationEngineClient.isConfigured()) {
      for await (const event of this.generationEngineClient.streamPrd(
        budgetedMessages as any,
        abortSignal,
      )) {
        if (event.type === "chunk") {
          yield event.content;
        } else if (event.type === "error") {
          throw new Error(event.message);
        } else if (event.type === "done") {
          return;
        }
      }
      return;
    }

    const result = await this.aiUtilService.AIGateway(
      "openai",
      "send-message",
      { messages: budgetedMessages },
      organizationId,
    );

    if (usageSink) {
      usageSink.usage = result.usage;
    }

    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }

  /**
   * Loads/validates the conversation, persists the user's message, streams the
   * assistant's reply (Generation engine when configured, in-process AIGateway
   * otherwise — `streamPrdText`, ticket #91) over SSE, then persists the full
   * reply as a new AiConversationMessage and closes the stream with a `done`
   * event.
   *
   * SSE event contract (see AiUtilService.sendSSE):
   *  - `chunk` (repeated): { content: string } — one incremental text delta
   *  - `done`  (once):     { message: AiConversationMessage } — the persisted AI reply
   *  - `error` (on failure only): { message: string }, response is ended after
   *
   * Validation failures that happen before we've written anything to the
   * response (missing fields, conversation not found) are raised as normal
   * Nest HTTP exceptions instead, so the client's SSE `onopen` handler sees a
   * non-2xx status and a JSON body rather than a stream.
   */
  async sendUserMessage(
    body: { conversationId: string; content: string; references?: any },
    response: Response,
    userId: string,
    organizationId: string,
  ): Promise<any> {
    const { conversationId, content, references } = body ?? ({} as typeof body);

    if (!conversationId || !content) {
      throw new BadRequestException("conversationId and content are required");
    }

    // Generate-only, the mirror of sendUserDocsMessage being Learn-only: this path answers
    // with a PRD, and a PRD in a Learn conversation could never be approved (approvePrd
    // refuses one), so it would be a proposal with no way to act on it.
    const conversation = await this.loadConversationOfType(
      conversationId,
      "generate",
      userId,
    );

    // Conversation history precedes the new user message; it's fetched before
    // persisting so the new message isn't accidentally double-counted.
    const priorMessages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );

    const userMessage = await this.aiConversationMessageRepository.createOne({
      aiConversationId: conversationId,
      messageType: "user",
      content,
      references: references ?? null,
      isLatest: true,
    });

    // Ticket #61: feasibility gating — refuse to burn an LLM call on a request that names
    // non-existent entities or is too vague to act on. The verdict is persisted as a normal
    // AI message so the thread continues and the user can clarify.
    const inventory = await this.assembleAppInventory(conversation.appId);
    const verdict = this.aiFeasibilityService.assess(
      content,
      inventory,
      references,
    );
    if (verdict.type !== "feasible") {
      this.aiUtilService.initSSE(response);
      this.aiUtilService.startHeartbeat(response);

      const aiContent =
        verdict.type === "infeasible"
          ? verdict.messageForUser
          : `I don't have enough detail to build that. Here are a few ways to proceed:\n\n${verdict.recommendations
              .map((recommendation) => `- ${recommendation}`)
              .join("\n")}`;

      const aiMessage = await this.aiConversationMessageRepository.createOne({
        aiConversationId: conversationId,
        messageType: "ai",
        content: aiContent,
        parentId: userMessage.id,
        isLatest: true,
        metadata: { feasibility: verdict },
      });

      this.aiUtilService.sendSSE(response, "done", { message: aiMessage });
      response.end();
      return;
    }

    const messages = this.buildPrdMessages(
      priorMessages,
      content,
      this.buildMentionedResourcesContext(references),
    );
    const { messages: budgetedMessages, truncated } =
      await this.aiUtilService.fitMessagesToContextWindowForOrg(
        organizationId,
        messages,
      );
    if (truncated.length) {
      this.logger.warn(
        `[sendUserMessage] context truncated: ${JSON.stringify(truncated)}`,
      );
    }

    this.aiUtilService.initSSE(response);
    this.aiUtilService.startHeartbeat(response);
    const endActiveRun = await this.beginActiveRun(
      conversation.id,
      userId,
      organizationId,
      response,
    );

    let fullText = "";
    // Ticket #91: a disconnecting browser also aborts the upstream Generation
    // engine request, rather than leaving it generating with nowhere to send
    // the result. No-op for the in-process AIGateway fallback.
    const abortController = new AbortController();
    response.once("close", () => abortController.abort());

    try {
      const usageSink: { usage?: Promise<any> | any } = {};
      for await (const chunk of this.streamPrdText(
        budgetedMessages,
        organizationId,
        abortController.signal,
        usageSink,
      )) {
        fullText += chunk;
        this.aiUtilService.sendSSE(response, "chunk", { content: chunk });
      }

      const metadata = await this.captureUsageMetadata(usageSink);

      const aiMessage = await this.aiConversationMessageRepository.createOne({
        aiConversationId: conversationId,
        messageType: "ai",
        content: fullText,
        parentId: userMessage.id,
        isLatest: true,
        metadata,
      });

      this.aiUtilService.sendSSE(response, "done", { message: aiMessage });
      response.end();
    } catch (error) {
      this.logger.error(
        `[sendUserMessage] conversationId=${conversationId} failed: ${error?.message}`,
        error?.stack,
      );
      this.aiUtilService.sendSSE(response, "error", {
        message: error?.message || "Something went wrong",
      });
      response.end();
    } finally {
      endActiveRun();
    }
  }

  /**
   * Shared Learn-conversation message shape, the counterpart to `buildPrdMessages`. The App
   * inventory rides as a second system message rather than being spliced into
   * LEARN_SYSTEM_PROMPT so the two stay separable: the prompt is a constant, the inventory is
   * re-assembled per message (ADR-0011) and is the only part that changes as the App does.
   */
  private buildLearnMessages(
    inventory: string,
    priorMessages: AiConversationMessage[],
    trailingUserContent?: string,
    referencesContext?: string | null,
  ) {
    return [
      { role: "system", content: LEARN_SYSTEM_PROMPT },
      {
        role: "system",
        content: `App inventory (current, assembled just now):\n\n${inventory}`,
      },
      ...(referencesContext
        ? [{ role: "system", content: referencesContext }]
        : []),
      ...priorMessages.map((message) => ({
        role: message.messageType === "user" ? "user" : "assistant",
        content: message.content,
      })),
      ...(trailingUserContent
        ? [{ role: "user", content: trailingUserContent }]
        : []),
    ];
  }

  /**
   * The Learn-conversation counterpart to `sendUserMessage`: answers a question about the App
   * instead of proposing a PRD. Same persistence and same SSE contract (`chunk`/`done`/
   * `error`) — the chat panel renders both kinds of thread through one code path — and the
   * same LocalAI-compatible chat endpoint via AIGateway.
   *
   * What differs is the grounding: a fresh `App inventory` is assembled for *this* message and
   * passed as context (ADR-0011 — no retrieval, no embeddings, no persisted index). Assembly
   * happens inside the try/catch, so a failure to read the App surfaces as the same chat
   * `error` an LLM/network failure would, and the user resends manually; nothing here retries
   * or silently degrades to an answer with no grounding.
   */
  async sendUserDocsMessage(
    body: { conversationId: string; content: string; references?: any },
    response: Response,
    userId: string,
    organizationId: string,
  ): Promise<any> {
    const { conversationId, content, references } = body ?? ({} as typeof body);

    if (!conversationId || !content) {
      throw new BadRequestException("conversationId and content are required");
    }

    const conversation = await this.loadConversationOfType(
      conversationId,
      "learn",
      userId,
    );

    const priorMessages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );

    const userMessage = await this.aiConversationMessageRepository.createOne({
      aiConversationId: conversationId,
      messageType: "user",
      content,
      references: references ?? null,
      isLatest: true,
    });

    this.aiUtilService.initSSE(response);
    this.aiUtilService.startHeartbeat(response);
    const endActiveRun = await this.beginActiveRun(
      conversation.id,
      userId,
      organizationId,
      response,
    );

    let fullText = "";

    try {
      const inventory = await this.assembleAppInventory(conversation.appId);
      const messages = this.buildLearnMessages(
        inventory,
        priorMessages,
        content,
        this.buildMentionedResourcesContext(references),
      );
      const { messages: budgetedMessages, truncated } =
        await this.aiUtilService.fitMessagesToContextWindowForOrg(
          organizationId,
          messages,
        );
      if (truncated.length) {
        this.logger.warn(
          `[sendUserDocsMessage] context truncated: ${JSON.stringify(truncated)}`,
        );
      }

      const result = await this.aiUtilService.AIGateway(
        "openai",
        "send-docs-message",
        { messages: budgetedMessages },
        organizationId,
      );

      for await (const chunk of result.textStream) {
        fullText += chunk;
        this.aiUtilService.sendSSE(response, "chunk", { content: chunk });
      }

      const metadata = await this.captureUsageMetadata(result);

      const aiMessage = await this.aiConversationMessageRepository.createOne({
        aiConversationId: conversationId,
        messageType: "ai",
        content: fullText,
        parentId: userMessage.id,
        isLatest: true,
        metadata,
      });

      this.aiUtilService.sendSSE(response, "done", { message: aiMessage });
      response.end();
    } catch (error) {
      this.logger.error(
        `[sendUserDocsMessage] conversationId=${conversationId} failed: ${error?.message}`,
        error?.stack,
      );
      this.aiUtilService.sendSSE(response, "error", {
        message: error?.message || "Something went wrong",
      });
      response.end();
    } finally {
      endActiveRun();
    }
  }

  private async assembleAppInventory(appId: string): Promise<string> {
    const appVersionId = await this.resolveAppVersionId(appId);
    return this.appInventoryService.assemble(appId, appVersionId);
  }

  /**
   * Promotes a Learn conversation into building (ADR-0012): creates a *new* Generate
   * conversation and seeds it with a `Context seed` — the one question and answer that
   * triggered the promotion, not the whole Learn thread. The Learn conversation itself is not
   * touched, keeps its `conversationType`, and stays independently accessible.
   *
   * `messageId` names the AI answer being promoted; its `parentId` is the question that
   * prompted it. Omitting it promotes the conversation's latest AI answer, which is what the
   * chat panel's action does when the user promotes from the bottom of the thread.
   *
   * The seed is persisted as the new conversation's first *user* message, so the Generate
   * flow reads it as ordinary conversation history: the next message the user sends produces
   * a PRD that already has this context, with no special-casing anywhere in `sendUserMessage`.
   */
  async promoteConversation(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<any> {
    if (!conversationId) {
      throw new BadRequestException("conversationId is required");
    }

    const conversation = await this.loadConversationOfType(
      conversationId,
      "learn",
      userId,
    );

    const messages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );
    const answer = messageId
      ? messages.find(
          (message) => message.id === messageId && message.messageType === "ai",
        )
      : [...messages].reverse().find((message) => message.messageType === "ai");
    if (!answer) {
      throw new BadRequestException(
        "No answer to promote in this conversation",
      );
    }

    const question = messages.find((message) => message.id === answer.parentId);

    const generateConversation = await this.aiUtilService.createNewConversation(
      userId,
      conversation.appId,
      "generate",
      undefined,
      true,
    );

    // Recorded alongside `handoff` so the originating thread stays traceable from the new one —
    // the two conversations are otherwise unrelated rows, which is exactly ADR-0012's point.
    const metadata = {
      ...(generateConversation.metadata || {}),
      promotedFromConversationId: conversationId,
    };
    await this.aiConversationRepository.updateOne(generateConversation.id, {
      metadata,
    });
    generateConversation.metadata = metadata;

    const seedMessage = await this.aiConversationMessageRepository.createOne({
      aiConversationId: generateConversation.id,
      messageType: "user",
      content: this.buildContextSeed(question?.content, answer.content),
      isLatest: true,
    });

    return { ...generateConversation, messages: [seedMessage] };
  }

  // Both halves are truncated: the seed is a condensed handoff (CONTEXT.md's "Context seed"),
  // and a Learn answer can run long enough to dominate the PRD conversation it's seeding.
  private buildContextSeed(question: string, answer: string): string {
    const MAX_SEED_PART_CHARS = 1500;
    const condense = (text: string) =>
      (text || "").trim().length > MAX_SEED_PART_CHARS
        ? `${(text || "").trim().slice(0, MAX_SEED_PART_CHARS)}…`
        : (text || "").trim();

    return [
      "Context carried over from a Learn conversation about this app:",
      "",
      ...(question ? [`Question: ${condense(question)}`, ""] : []),
      `Answer: ${condense(answer)}`,
      "",
      "I want to build on this.",
    ].join("\n");
  }

  /**
   * Rewinds a plan's execution to an earlier completed step (ADR-0008): every Step after
   * `stepId` within the same plan (same conversationId + the target's messageId — a later,
   * separately approved PRD's Steps carry a different messageId and are never touched) has
   * its Artifact's real App change reverted, oldest-undone-last (a later step can only ever
   * reference an earlier one's output, never the reverse), then its Step row is reset to
   * 'pending' with a cleared artifactId/errorMessage/attempts. The target step itself is
   * left as-is — rewind returns the plan to the state right after it finished, not before.
   *
   * `inclusive` (ADR-0022, ticket #15) extends the same discard to the target step itself: rewinding
   * inclusively to the plan's first step is how the offered "undo this build" action after a
   * failure undoes everything the plan built. No separate discard path — the undo ordering,
   * the Artifact revert and the Step reset are exactly rewind's.
   *
   * Not a streaming endpoint: there's no LLM call on this path, just DB/App-state undos.
   */
  async rewindStep(
    conversationId: string,
    stepId: string,
    userId: string,
    organizationId: string,
    inclusive = false,
  ): Promise<any> {
    if (!conversationId || !stepId) {
      throw new BadRequestException("conversationId and stepId are required");
    }

    const conversation = await this.loadConversationOfType(
      conversationId,
      "generate",
      userId,
    );

    const targetStep = await this.stepRepository.findById(stepId);
    if (!targetStep || targetStep.conversationId !== conversationId) {
      throw new NotFoundException("Step not found in this conversation");
    }
    if (targetStep.status !== "succeeded") {
      throw new BadRequestException("Can only rewind to a completed step");
    }

    const appVersionId = await this.resolveAppVersionId(conversation.appId);
    const stepsAfter = await this.stepRepository.findAfterOrder(
      conversationId,
      targetStep.messageId,
      targetStep.order,
    );
    const stepsToUndo = inclusive ? [targetStep, ...stepsAfter] : stepsAfter;

    for (const step of [...stepsToUndo].reverse()) {
      if (step.status === "succeeded" && step.artifactId) {
        const artifact = await this.artifactRepository.findById(
          step.artifactId,
        );
        if (artifact) {
          await this.agentsService.undoArtifact(
            step.type,
            appVersionId,
            organizationId,
            artifact.content,
          );
          await this.artifactRepository.deleteOne(artifact.id);
        }
      }
      await this.stepRepository.updateOne(step.id, {
        status: "pending",
        artifactId: null,
        errorMessage: null,
        attempts: 0,
      });
    }

    return {
      rewoundTo: targetStep.id,
      undone: stepsToUndo.map((step) => step.id),
    };
  }

  /**
   * Marks one Step of a running plan as skipped (ticket #21). Not a streaming endpoint and
   * not an executor: it only records the user's decision; approvePrd's execution loop acts
   * on it at its next checkpoint. A pending step is skipped before it ever starts; a running
   * one finishes its in-flight LLM call and then has its outcome discarded (and any Artifact
   * it already produced undone) by the loop. Failed steps can't be skipped — a failed plan
   * has already stopped, and retrying it is rewind + re-approve, not skip.
   */
  async skipStep(
    conversationId: string,
    stepId: string,
    userId: string,
  ): Promise<any> {
    if (!conversationId || !stepId) {
      throw new BadRequestException("conversationId and stepId are required");
    }

    await this.loadConversationOfType(conversationId, "generate", userId);

    const step = await this.stepRepository.findById(stepId);
    if (!step || step.conversationId !== conversationId) {
      throw new NotFoundException("Step not found in this conversation");
    }
    // Ticket #77 / ADR-0042: 'awaiting_confirmation' is also skippable — declining an
    // external CreateTable step's confirmation gate is surfaced through this same endpoint
    // (the ADR's "same run-UI channel Skip already uses"), not a parallel decline path.
    // executeCreateTableStep's poll loop is what turns this into "declined, no DDL issued".
    if (
      step.status !== "pending" &&
      step.status !== "running" &&
      step.status !== "awaiting_confirmation"
    ) {
      throw new BadRequestException(
        "Only a pending, running, or awaiting-confirmation step can be skipped",
      );
    }

    await this.stepRepository.updateOne(step.id, { status: "skipped" });
    return { skipped: step.id };
  }

  /**
   * Ticket #77 / ADR-0042: records the user's explicit go-ahead on an external CreateTable
   * step's confirmation gate. Not SSE — the execution loop's poll (inside
   * awaitExternalTableConfirmation) picks the new status up on its next check, the same
   * checkpoint shape skipStep already uses for Skip.
   */
  async confirmStep(
    conversationId: string,
    stepId: string,
    userId: string,
  ): Promise<any> {
    if (!conversationId || !stepId) {
      throw new BadRequestException("conversationId and stepId are required");
    }

    await this.loadConversationOfType(conversationId, "generate", userId);

    const step = await this.stepRepository.findById(stepId);
    if (!step || step.conversationId !== conversationId) {
      throw new NotFoundException("Step not found in this conversation");
    }
    if (step.status !== "awaiting_confirmation") {
      throw new BadRequestException(
        "Only a step awaiting confirmation can be confirmed",
      );
    }

    await this.stepRepository.updateOne(step.id, { status: "confirmed" });
    return { confirmed: step.id };
  }

  /**
   * Regenerates the AI reply to `parentMessageId` (ADR-0009): marks the current `isLatest`
   * reply `isLatest: false` and inserts a new sibling — same `parentId`, `isLatest: true` —
   * generated from the same conversation history (every currently-`isLatest` message up to
   * and including `parentMessageId`) the original reply was generated from. Only the
   * conversation's current last turn can be regenerated (see ADR-0009 for why); a stale-
   * message check would need to cascade-invalidate everything after it, which nothing here
   * does. approvePrd already picks up whichever AI message is `isLatest` last, so a
   * regenerated PRD automatically replaces the prior one as the pending-approval PRD —
   * nothing there needs to change for that.
   */
  async regenerateAiMessage(
    parentMessageId: string,
    userId: string,
    organizationId: string,
  ): Promise<any> {
    if (!parentMessageId) {
      throw new BadRequestException("parentMessageId is required");
    }

    const parentMessage =
      await this.aiConversationMessageRepository.findMessageById(
        parentMessageId,
      );
    if (!parentMessage) {
      throw new NotFoundException("Message not found");
    }

    const conversationId = parentMessage.aiConversationId;
    // Regeneration reads the target conversation's history and re-runs an LLM call grounded in
    // it, so ownership is enforced up front — otherwise a known message UUID lets any user
    // consume AI credits and read/mutate a thread that isn't theirs.
    const conversation =
      await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException("Conversation not found");
    }
    const latestMessages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );
    const parentIndex = latestMessages.findIndex(
      (message) => message.id === parentMessageId,
    );
    if (parentIndex === -1) {
      throw new BadRequestException(
        "Message is not part of the active conversation branch",
      );
    }

    const staleReply = latestMessages[parentIndex + 1];
    if (
      !staleReply ||
      staleReply.parentId !== parentMessageId ||
      staleReply.messageType !== "ai"
    ) {
      throw new BadRequestException(
        "No AI reply to regenerate for this message",
      );
    }
    if (parentIndex + 1 !== latestMessages.length - 1) {
      throw new BadRequestException(
        "Only the latest message in the conversation can be regenerated",
      );
    }

    const priorMessages = latestMessages.slice(0, parentIndex + 1);
    // Regenerate works identically for both conversation types, but "the same history the
    // original reply was generated from" means a different prompt in each: a Learn reply came
    // from the Learn prompt plus an App inventory, and regenerating it against the PRD prompt
    // would silently turn a Q&A answer into a build proposal. The inventory is re-assembled
    // rather than reused (ADR-0011) — the App may well have changed since the first attempt.
    const messages =
      conversation?.conversationType === "learn"
        ? this.buildLearnMessages(
            await this.assembleAppInventory(conversation.appId),
            priorMessages,
          )
        : this.buildPrdMessages(priorMessages);
    const { messages: budgetedMessages, truncated } =
      await this.aiUtilService.fitMessagesToContextWindowForOrg(
        organizationId,
        messages,
      );
    if (truncated.length) {
      this.logger.warn(
        `[regenerateAiMessage] context truncated: ${JSON.stringify(truncated)}`,
      );
    }

    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "regenerate-message",
      { messages: budgetedMessages },
      organizationId,
    );

    await this.aiConversationMessageRepository.updateOne(staleReply.id, {
      isLatest: false,
    });

    return await this.aiConversationMessageRepository.createOne({
      aiConversationId: conversationId,
      messageType: "ai",
      content: result?.text || "",
      parentId: parentMessageId,
      isLatest: true,
    });
  }

  /**
   * Self-hosted CE has no credit accounting: the `ai` feature is unconditionally
   * enabled (see BASIC_PLAN_TERMS.features.ai) and usage is unlimited, so this
   * never touches organization_ai_credit_history / selfhost_ai_credit_history.
   */
  async getCreditsBalance(
    organizationId,
  ): Promise<{ aiFeaturesEnabled: boolean; error?: string }> {
    return {
      aiFeaturesEnabled: true,
    };
  }

  /**
   * Both conversation types are listed and created through the same pair of endpoints,
   * separated only by `conversationType` — a Learn thread and a Generate thread for the same
   * App are independent lists, never interleaved.
   *
   * The type is normalized here rather than trusted from the request: it's an enum column and
   * a fixed-for-life property (ADR-0012), so an unrecognized value has no meaningful behaviour
   * to fall back to — failing at the boundary beats persisting a row that no listing can find.
   */
  private resolveConversationType(conversationType: string): ConversationType {
    if (!conversationType) return "generate";
    if (!(CONVERSATION_TYPES as readonly string[]).includes(conversationType)) {
      throw new BadRequestException(
        `Unsupported conversationType "${conversationType}" — supported types are: ${CONVERSATION_TYPES.join(", ")}`,
      );
    }
    return conversationType as ConversationType;
  }

  async listConversations(
    appId: string,
    userId: string,
    conversationType: string,
  ): Promise<any> {
    return this.aiUtilService.getConversationsList(
      appId,
      userId,
      this.resolveConversationType(conversationType),
    );
  }

  /**
   * `organizationId` isn't used for anything conversation-scoped today
   * (conversations belong to an app/user, not an org) — it's accepted here to
   * satisfy IAiService and keep the door open for org-level checks later.
   */
  async createConversation(
    userId: string,
    appId: string,
    conversationType: string,
    organizationId: string,
    currentConversationId?: string,
    handoff?: boolean,
  ): Promise<any> {
    return this.aiUtilService.createNewConversation(
      userId,
      appId,
      this.resolveConversationType(conversationType),
      currentConversationId,
      handoff,
    );
  }

  async getConversationById(
    conversationId: string,
    userId: string,
  ): Promise<any> {
    return this.aiUtilService.getConversationById(conversationId, userId);
  }

  /**
   * Sums prompt/completion/total tokens across a thread's messages. Ownership is enforced the
   * same way as `getActiveRun` — a caller cannot probe another user's conversation.
   *
   * Usage is read from `message.metadata.usage` (ticket #64), populated at persist time on the
   * conversational send paths (`sendUserMessage`, `sendUserDocsMessage` — see
   * `captureUsageMetadata`). A message with no usage recorded (no provider figure, or one of
   * the call sites that doesn't yet capture it) is simply excluded from the sums rather than
   * treated as an error, per the ticket's acceptance criteria.
   */
  async getThreadTokenUsage(conversationId: string, user: any): Promise<any> {
    const conversation =
      await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== user.id) {
      throw new NotFoundException("Conversation not found");
    }

    const messages =
      await this.aiConversationMessageRepository.findLatestByConversationId(
        conversationId,
      );
    // Only "ai" messages can ever carry usage (it comes from a provider response) — counting
    // user turns here would make aiMessagesWithUsage read as "N messages are missing data"
    // when some of those N are simply the wrong message type to have any.
    const aiMessages = messages.filter(
      (message) => message.messageType === "ai",
    );

    let promptTokens = 0;
    let completionTokens = 0;
    let aiMessagesWithUsage = 0;

    for (const message of aiMessages) {
      const usage = message.metadata?.usage;
      if (!usage) {
        continue;
      }
      promptTokens += Number(usage.promptTokens) || 0;
      completionTokens += Number(usage.completionTokens) || 0;
      aiMessagesWithUsage += 1;
    }

    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      aiMessageCount: aiMessages.length,
      aiMessagesWithUsage,
    };
  }

  /**
   * Reads the token usage off a `streamText`/`generateText` result (AI SDK v4's `.usage`,
   * a promise resolving once generation is done) into the shape `getThreadTokenUsage` sums.
   * Never throws: a provider that omits usage (or an SDK version mismatch) should not break
   * message persistence, it should just leave this message out of the aggregation.
   */
  private async captureUsageMetadata(result: {
    usage?: Promise<any> | any;
  }): Promise<Record<string, any> | undefined> {
    try {
      const usage = await result.usage;
      if (!usage) {
        return undefined;
      }
      const promptTokens = Number(usage.promptTokens);
      const completionTokens = Number(usage.completionTokens);
      if (
        !Number.isFinite(promptTokens) &&
        !Number.isFinite(completionTokens)
      ) {
        return undefined;
      }
      return {
        usage: {
          promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
          completionTokens: Number.isFinite(completionTokens)
            ? completionTokens
            : 0,
        },
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Renders the `Error context` (CONTEXT.md) the model is asked to fix. Every line is
   * optional except the expression and the error, which `fixWithAi` has already validated —
   * a property with no resolved component/field name is unusual but not a reason to refuse a
   * fix, since the expression and the error alone are what determine the answer.
   *
   * The fallback line is emitted on an explicit `undefined` check rather than a truthy one:
   * a property that fell back to `[]`, `0`, `false` or `''` is telling the model what shape
   * the field is supposed to hold, which is exactly the case a truthiness test would drop.
   */
  private buildFixContextLines(context: ErrorContext): string {
    const {
      expression,
      errorMessage,
      componentName,
      componentType,
      propertyName,
      fallbackValue,
    } = context;
    const lines: string[] = [];

    if (componentName || componentType) {
      lines.push(
        `Component: ${[componentType, componentName].filter(Boolean).join(" ")}`,
      );
    }
    if (propertyName) {
      lines.push(`Property: ${propertyName}`);
    }
    lines.push(`Failing expression: ${expression}`);
    lines.push(`Error reported by the app runtime: ${errorMessage}`);
    if (fallbackValue !== undefined) {
      lines.push(
        `The property fell back to this value, which shows the shape it expects: ${summarizeFallbackValue(
          fallbackValue,
        )}`,
      );
    }

    return lines.join("\n");
  }

  /**
   * Produces one `Suggestion` for a component property whose expression failed to resolve
   * (CONTEXT.md's `Fix with AI`). Deliberately not a `Conversation`: no `conversationId` is
   * accepted, nothing is written to `ai_conversations`/`ai_conversation_messages`, and the
   * result isn't streamed — there is one question, one answer, and the client applies it into
   * a form field (ADR-0014). Structured output comes from the same forced-tool-call mechanism
   * `approvePrd`'s step execution uses (ADR-0003).
   *
   * A missing expression or error message is rejected rather than sent to the model: without
   * both, there is nothing to fix and no way to tell what "fixed" would mean, so the model
   * could only invent a replacement for a value the user never complained about.
   */
  async fixWithAi(
    body: ErrorContext,
    organizationId: string,
  ): Promise<Suggestion> {
    const { expression, errorMessage } = body ?? ({} as ErrorContext);

    // Type-checked, not just truthiness-checked: this endpoint takes a raw `@Body()`, and the
    // error a component reports isn't always a string — PreviewBox's own resolver can produce
    // an array of messages. A bare `.trim()` on one of those throws a TypeError, which would
    // surface to the user as a 500 "Internal server error" for what is really a bad request.
    if (!isNonEmptyString(expression)) {
      throw new BadRequestException(
        "expression is required and must be a non-empty string",
      );
    }
    if (!isNonEmptyString(errorMessage)) {
      throw new BadRequestException(
        "errorMessage is required and must be a non-empty string",
      );
    }

    const prompt = await this.budgetPromptForOrg(
      organizationId,
      {
        system: FIX_WITH_AI_SYSTEM_PROMPT,
        messages: [{ role: "user", content: this.buildFixContextLines(body) }],
      },
      "fixWithAi",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "fix-with-ai",
      {
        ...prompt,
        tools: { proposeFix: proposeFixTool },
        toolChoice: { type: "tool", toolName: "proposeFix" },
      },
      organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "proposeFix") {
      throw new Error("The assistant did not produce a fix");
    }

    const { fixedValue, explanation } = call.args as {
      fixedValue: string;
      explanation: string;
    };
    return { fixedValue, explanation };
  }

  /**
   * Assembles the `App inventory` for a `Copilot` request, or nothing at all.
   *
   * Unlike a Learn answer — which is *about* the App, and so is worthless ungrounded — a
   * completion without the inventory is still code in the right language doing roughly the
   * right thing; it just can't safely name the App's queries and components. So an App with
   * no version yet, or a repository that faults, degrades to an ungrounded completion rather
   * than failing the request (ADR-0016). The failure is logged because a *persistently*
   * ungrounded copilot looks to the user like a model that keeps making names up.
   */
  private async assembleCopilotInventory(
    appId?: string,
  ): Promise<string | null> {
    if (!appId) return null;

    try {
      return await this.assembleAppInventory(appId);
    } catch (error) {
      this.logger.warn(
        `[copilot] appId=${appId} inventory unavailable, answering ungrounded: ${error?.message}`,
        error?.stack,
      );
      return null;
    }
  }

  /**
   * Renders the `Copilot context` (CONTEXT.md) the model writes against. The prompt comes
   * last on purpose: everything above it is background the model should read first, and the
   * request itself is what it should still be holding when it starts writing.
   *
   * Both the inventory and the existing code are omitted entirely when absent rather than
   * rendered as empty sections — an "Already in the editor:" heading over nothing invites the
   * model to treat the blank as content and preserve it.
   */
  private buildCopilotContextLines(
    context: CopilotContext,
    inventory: string | null,
  ): string {
    const { prompt, currentCode, language, dataSourceKind } = context;
    const sections: string[] = [];

    sections.push(`Editor language: ${this.resolveCopilotLanguage(language)}`);
    if (isNonEmptyString(dataSourceKind)) {
      sections.push(
        `This query runs against a "${dataSourceKind}" data source.`,
      );
    }
    if (inventory) {
      sections.push(`Inventory of the app being edited:\n${inventory}`);
    }
    if (isNonEmptyString(currentCode) && isCodeTooLongToShow(currentCode)) {
      sections.push(
        "The editor already contains a body too long to include here, so you cannot see it. Write only what was asked, as a self-contained body, and open your explanation by warning that it replaces the existing code rather than extending it.",
      );
    } else if (isNonEmptyString(currentCode)) {
      sections.push(
        `Already in the editor, which is the user's work in progress:\n${currentCode}`,
      );
    } else {
      sections.push("The editor is empty.");
    }
    sections.push(`What the user asked for:\n${prompt.trim()}`);

    return sections.join("\n\n");
  }

  private resolveCopilotLanguage(language?: string): string {
    const normalized = (language || "").trim().toLowerCase();
    return SUPPORTED_COPILOT_LANGUAGES.includes(normalized)
      ? normalized
      : DEFAULT_COPILOT_LANGUAGE;
  }

  /**
   * Produces one `Completion` for a query editor from the user's plain-language description
   * (CONTEXT.md's `Copilot`). Like `fixWithAi` and for the same reasons, this is not a
   * `Conversation`: no `conversationId`, nothing written to `ai_conversations`/
   * `ai_conversation_messages`, not streamed — the client can't apply half a query body
   * (ADR-0016). Structured output comes from a forced tool call through `AIGatewayGenerate`
   * (ADR-0003).
   *
   * Only the prompt is required. Type-checked rather than truthiness-checked for the same
   * reason `fixWithAi` checks its inputs: this takes a raw `@Body()`, and `.trim()` on a
   * non-string would surface as a 500 for what is a malformed request.
   */
  async copilot(
    body: CopilotContext,
    organizationId: string,
  ): Promise<Completion> {
    const { prompt } = body ?? ({} as CopilotContext);

    if (!isNonEmptyString(prompt)) {
      throw new BadRequestException(
        "prompt is required and must be a non-empty string",
      );
    }

    const inventory = await this.assembleCopilotInventory(body.appId);

    const budgetedPrompt = await this.budgetPromptForOrg(
      organizationId,
      {
        system: COPILOT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: this.buildCopilotContextLines(body, inventory),
          },
        ],
      },
      "copilot",
    );
    const result = await this.aiUtilService.AIGatewayGenerate(
      "openai",
      "copilot",
      {
        ...budgetedPrompt,
        tools: { writeCode: writeCodeTool },
        toolChoice: { type: "tool", toolName: "writeCode" },
      },
      organizationId,
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== "writeCode") {
      throw new Error("The assistant did not produce any code");
    }

    const { code, explanation } = call.args as {
      code: string;
      explanation: string;
    };
    return { code, explanation };
  }
}
