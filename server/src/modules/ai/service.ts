import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { tool } from 'ai';
import { z } from 'zod';
import { IAiService } from './interfaces/IService';
import { AiUtilService } from './util.service';
import { AgentsService } from './services/agents.service';
import { AiConversationRepository } from './repositories/ai-conversation.repository';
import { AiConversationMessageRepository } from './repositories/ai-conversation-message.repository';
import { ArtifactRepository } from './repositories/artifact.repository';
import { StepRepository } from './repositories/step.repository';
import { AiResponseVoteRepository } from './repositories/ai-response-vote.repository';
import { AppInventoryService } from './services/app-inventory.service';
import {
  DataSourceInventoryService,
  QueryableDataSource,
  renderConnectedDataSources,
} from './services/data-source-inventory.service';
import { VersionRepository } from '@modules/versions/repository';
import { Step, StepType } from '@entities/step.entity';
import { Artifact } from '@entities/artifact.entity';
import { AiConversation } from '@entities/ai_conversation.entity';
import { AiConversationMessage } from '@entities/ai_conversation_message.entity';
import { Completion, CopilotContext, ErrorContext, Suggestion } from './types';
import { User } from '@entities/user.entity';
import { UserPermissions } from '@modules/ability/types';

const CONVERSATION_TYPES = ['generate', 'learn'] as const;
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
// ADR-0006 — even though only CreateTable has a real handler in this ticket.
const STEP_TYPES = ['CreateTable', 'CreateQuery', 'CreateComponent'] as const;

export const STEP_PLAN_SYSTEM_PROMPT = `You turn an approved Product Requirements Document (PRD) into an ordered build plan for a ToolJet app.

Call proposeStepPlan exactly once with the ordered list of steps needed to build what the PRD describes. Each step is one of:
- CreateTable: creates a ToolJet DB table. Include the full table definition you propose in the optional table field — the user previews exactly that definition (tables, columns, foreign keys) before approving, and it is what gets created.
  If the PRD asks for sample or starting data, also propose it in the optional seed_rows field: rows consistent with the table's columns, omitting auto-generated (serial) primary key columns. The user previews the exact rows before approving, and they are inserted into the table as part of this step. Never invent seed rows the PRD does not call for.
- CreateQuery: creates a data query, either against a ToolJet DB table or against a data source the user has already connected.
- CreateComponent: creates a UI element (a page or a widget on a page).

Order matters: a table must exist before a query reads from it, and a query before a component that uses it. Give each step a short, specific description of what it builds.

Also group the steps into a small number of named phases (ticket #21) — e.g. "Create data tables", "Create data queries", "Build the interface". Set each step's phase to a short human-readable phase name; consecutive steps that belong to the same phase must repeat the exact same phase string. Use between 1 and 4 phases, in execution order.`;

// ToolJet DB's supported column types (server/src/modules/tooljet-db/types.ts's TJDB map).
const TJDB_DATA_TYPES = [
  'character varying',
  'integer',
  'bigint',
  'serial',
  'double precision',
  'boolean',
  'timestamp with time zone',
  'jsonb',
] as const;

export const TJDB_FOREIGN_KEY_ACTIONS = ['RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'] as const;

// The full definition of one ToolJet DB table, shared by the planner (which proposes it at
// plan time so it can be previewed before approval, ticket #20) and the per-step createTable
// tool (which historically was the only place a table's schema existed, at execution time).
const tableDefinitionObject = z.object({
  table_name: z.string().describe('snake_case table name, unique within this app'),
  columns: z
    .array(
      z.object({
        column_name: z.string(),
        data_type: z.enum(TJDB_DATA_TYPES),
        is_primary_key: z.boolean(),
        is_not_null: z.boolean(),
        is_unique: z.boolean(),
      })
    )
    .min(1)
    .describe('Exactly one column must have is_primary_key: true'),
  foreign_keys: z
    .array(
      z.object({
        // One or more columns in this table that must reference a column (or columns)
        // in another table in this app.
        column_names: z.array(z.string()).min(1).describe('Column(s) in this table that are referenced'),
        referenced_table_name: z.string().describe('Name of another table in this app that these columns reference'),
        referenced_column_names: z
          .array(z.string())
          .min(1)
          .describe('Column(s) in referenced_table_name that these columns reference'),
        on_delete: z
          .enum(TJDB_FOREIGN_KEY_ACTIONS)
          .describe(
            "Action when a referenced row is deleted; one of 'RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'"
          )
          .optional(),
        on_update: z
          .enum(TJDB_FOREIGN_KEY_ACTIONS)
          .describe(
            "Action when a referenced row is updated; one of 'RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'"
          )
          .optional(),
      })
    )
    .optional()
    .describe(
      'Relationships to other tables in this app. Omit this field to create a table with no foreign keys. ' +
        'Referenced tables must already exist in this app.'
    ),
});

type TableDefinition = z.infer<typeof tableDefinitionObject>;

// One seed row the planner proposes for a table it also proposes (ticket #48): a plain
// record of column name → primitive value. Structured rows, not SQL — the same principle
// ADR-0020 set for the table definition itself, so the preview renders the data (not a
// query) and execution inserts exactly what was previewed, with no SQL surface anywhere.
const seedRowObject = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

const seedRowsObject = z
  .array(seedRowObject)
  .min(1)
  .max(50)
  .describe(
    'Seed rows to insert after this table is created. Only when the PRD asks for sample/starting data. ' +
      'Each row maps column names to values and must be consistent with the columns defined above; ' +
      'omit auto-generated (serial) primary key columns.'
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
      typeof row === 'object' &&
      !Array.isArray(row) &&
      Object.keys(row).length > 0 &&
      Object.values(row).every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
  );

// A planned table is trusted verbatim only when it could actually create a table: a real
// (non-blank) name and at least one column with a name and a type. Anything looser falls
// back to the per-step LLM path rather than failing execution on a malformed contract.
// Seed rows are only as good as their fit to the table they seed: every key must be a real
// column of the planned table (ticket #48). Column order and completeness are not required —
// a serial primary key may be omitted — but an unknown column would fail at insert time.
const areSeedRowsConsistentWithTable = (rows: Record<string, any>[], table: TableDefinition): boolean => {
  const columnNames = new Set(table.columns.map((column) => column.column_name));
  return rows.every((row) => Object.keys(row).every((key) => columnNames.has(key)));
};

const isWellFormedTableDefinition = (table: any): table is TableDefinition =>
  Boolean(
    table &&
    typeof table.table_name === 'string' &&
    table.table_name.trim() &&
    Array.isArray(table.columns) &&
    table.columns.length > 0 &&
    table.columns.every(
      (column: any) =>
        column &&
        typeof column.column_name === 'string' &&
        column.column_name.trim() &&
        typeof column.data_type === 'string'
    )
  );

export const proposeStepPlanTool = tool({
  description: 'Propose the ordered list of build steps for this PRD.',
  parameters: z.object({
    steps: z
      .array(
        z.object({
          type: z.enum(STEP_TYPES),
          description: z.string().describe('Short, specific description of what this step builds'),
          // Only meaningful on CreateTable steps: the concrete table definition this step
          // proposes, persisted as the Step's plannedTable and shown in the pre-approval
          // schema preview (ticket #20).
          table: tableDefinitionObject.optional(),
          // Only meaningful on CreateTable steps: the seed rows this step proposes to insert
          // after the table is created (ticket #48), persisted as the Step's plannedSeedRows
          // and shown in the pre-approval schema preview alongside the table.
          seed_rows: seedRowsObject.optional(),
          // The named phase this step belongs to (ticket #21). Optional so an older planner
          // response without one still validates — a missing phase falls back to a single
          // derived group on the client.
          phase: z.string().optional().describe('Short human-readable phase name this step belongs to'),
        })
      )
      .min(1),
  }),
});

export const CREATE_TABLE_SYSTEM_PROMPT = `You design the exact schema for one ToolJet DB table, based on the PRD and the specific step you've been asked to build.

Call createTable exactly once with the table's real name (snake_case) and its columns. Every table needs exactly one primary key column (usually an auto-generated "id" of type serial). Pick sensible, minimal columns that satisfy what this step describes — don't invent columns the PRD doesn't call for.

If this table's rows must always reference rows in another table in this app (for example a "customer_id" that must exist in the "customers" table), declare that relationship with the optional foreign_keys field: list the column(s) in this table, the referenced table, and the referenced column(s); optionally set on_delete/on_update to one of 'RESTRICT', 'NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'. Only reference tables that already exist in this app — the referenced table's columns must match the column names you list. Omit foreign_keys when no such relationship is needed.`;

export const createTableTool = tool({
  description: 'Create a ToolJet DB table with the given name and columns.',
  parameters: tableDefinitionObject,
});

// The full allow-list (ADR-0002's v1 set — Page, Table, Form, Button, Text, TextInput,
// Container — extended per ticket #13 with Chart, Image, Checkbox, Dropdown, Modal).
// Unlike an unsupported *Step* type (ADR-0006, which can never
// succeed since no handler exists), an unsupported *component* type is retried: the model
// picks it per attempt, so a later retry can self-correct to a supported one.
const SUPPORTED_COMPONENT_TYPES = [
  'Page',
  'Table',
  'Button',
  'Text',
  'TextInput',
  'Container',
  'Form',
  'Chart',
  'Image',
  'Checkbox',
  'Dropdown',
  'Modal',
] as const;

// Component types that place a widget on an existing Page — everything except 'Page'
// itself (which creates one). Used to validate `pageId` uniformly across all of them.
const PAGE_WIDGET_TYPES = SUPPORTED_COMPONENT_TYPES.filter((type) => type !== 'Page');

const CREATE_COMPONENT_SYSTEM_PROMPT = `You create one UI element for this step, based on the PRD and whatever earlier steps in this plan already created (listed below, if any).

Call createComponent exactly once. Supported component types: Page, Table, Button, Text, TextInput, Container, Form, Chart, Image, Checkbox, Dropdown, Modal.
- Page: give it a short, specific name.
- Table: reference the id of a Page already created in this plan to place it on, give it a title, and reference the name of a query already created in this plan whose data it should display.
- Button: reference a Page id, give it a short label.
- Text: reference a Page id, give it the text to display.
- TextInput: reference a Page id, give it a label (and an optional placeholder).
- Container: reference a Page id, give it a short title.
- Form: reference a Page id, the id of a ToolJet DB table already created in this plan, and a form title. By default (mode "create") this produces a working create-record form — you don't need a separate query or event step for it. When the PRD wants to edit existing records, set mode "edit" and also reference the name of a Table widget already created in this plan that is bound to the same underlying table — the form's fields then pre-fill from that Table's selected row and submitting runs an update keyed on that row.
- Chart: reference a Page id, give it a title, and optionally reference the name of a query already created in this plan whose data it should plot (omit queryName to get an empty chart). Pick a chartType from "line", "bar", "pie" (default "line").
- Image: reference a Page id and give the image's source URL (and an optional alt text).
- Checkbox: reference a Page id, give it a label, and optionally set defaultChecked.
- Dropdown: reference a Page id, give it a label, and provide its options as a list of short strings (optionally a placeholder).
- Modal: reference a Page id, give it a title; it renders with a default trigger button (optionally set the trigger button label). Place Modal's content as separate sibling widgets on the page — widgets cannot be nested inside it.
Only reference pages/tables/queries that actually appear in the context below — never invent an id or name.`;

const createComponentTool = tool({
  description:
    'Create a Page, or a widget (Table, Button, Text, TextInput, Container, Form, Chart, Image, Checkbox, Dropdown, Modal) on an existing Page.',
  parameters: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('Page'),
      name: z.string().describe('Short page title, e.g. "Orders"'),
    }),
    z.object({
      type: z.literal('Table'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this table on'),
      title: z.string().describe('Table title shown in the UI'),
      queryName: z.string().describe('name of an already-created query (from context) this table should display'),
    }),
    z.object({
      type: z.literal('Button'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this button on'),
      text: z.string().describe('Button label text'),
    }),
    z.object({
      type: z.literal('Text'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this text on'),
      text: z.string().describe('Text content to display'),
    }),
    z.object({
      type: z.literal('TextInput'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this input on'),
      label: z.string().describe('Input label'),
      placeholder: z.string().optional().describe('Placeholder text'),
    }),
    z.object({
      type: z.literal('Container'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this container on'),
      title: z.string().describe('Short container title'),
    }),
    z.object({
      type: z.literal('Form'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this form on'),
      tableId: z
        .string()
        .describe(
          'id of an already-created ToolJet DB table (from context) this form creates records in or edits records in'
        ),
      title: z.string().describe('Form title'),
      mode: z
        .enum(['create', 'edit'])
        .default('create')
        .describe(
          "'create' (default) wires a create_row query to submit; 'edit' wires an update_rows query keyed on the referenced Table's selectedRow and pre-fills the fields from it"
        ),
      tableName: z
        .string()
        .optional()
        .describe(
          "name of an already-created Table widget (from context) whose selectedRow this form binds to — required when mode='edit'"
        ),
    }),
    z.object({
      type: z.literal('Chart'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this chart on'),
      title: z.string().describe('Chart title shown in the UI'),
      queryName: z
        .string()
        .optional()
        .describe('name of an already-created query (from context) whose data this chart should plot'),
      chartType: z
        .enum(['line', 'bar', 'pie'])
        .default('line')
        .describe("Chart rendering style; default 'line'"),
    }),
    z.object({
      type: z.literal('Image'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this image on'),
      source: z.string().describe('Image source URL'),
      alternativeText: z.string().optional().describe('Alt text for the image'),
    }),
    z.object({
      type: z.literal('Checkbox'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this checkbox on'),
      label: z.string().describe('Checkbox label'),
      defaultChecked: z.boolean().optional().describe('Whether the checkbox starts checked (default false)'),
    }),
    z.object({
      type: z.literal('Dropdown'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this dropdown on'),
      label: z.string().describe('Dropdown label'),
      options: z.array(z.string()).min(1).describe('The choices to offer, as short strings, in display order'),
      placeholder: z.string().optional().describe('Placeholder shown before a choice is made'),
    }),
    z.object({
      type: z.literal('Modal'),
      pageId: z.string().describe('id of an already-created Page (from context) to place this modal on'),
      title: z.string().describe('Modal title shown in its title bar'),
      triggerButtonLabel: z.string().optional().describe('Label of the default trigger button that opens the modal'),
    }),
  ]),
});

const CREATE_QUERY_SYSTEM_PROMPT = `You create one data query for this step, based on the PRD, the table(s) already created earlier in this plan, and the connected data sources listed below (if any).

Call createQuery exactly once with a short snake_case query name (components will reference it as {{queries.<name>.data}}) and the query itself:
- source "tooljetdb" — the default. Give the real id of a ToolJet DB table created earlier in this plan to list rows from.
- source "sql" — only when this step is meant to read from a data source the user has already connected. Give that source's real id and one SQL SELECT statement against a table that source actually has.

Every id must come from the context below, never invented. Prefer ToolJet DB unless the PRD or this step clearly asks for data that lives in a connected source.`;

// Discriminated on `source` rather than left as one loose object, for the same reason
// createComponentTool is: the two branches share only a name, and a single flat schema would
// let the model return an SQL string with a ToolJet DB table id, which is unbuildable.
const createQueryTool = tool({
  description: 'Create a query against an existing ToolJet DB table, or against a connected SQL data source.',
  parameters: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('tooljetdb'),
      name: z
        .string()
        .describe('snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}'),
      table_id: z.string().describe('id of an already-created ToolJet DB table (from context)'),
    }),
    z.object({
      source: z.literal('sql'),
      name: z
        .string()
        .describe('snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}'),
      data_source_id: z.string().describe('id of a connected data source (from the list in context)'),
      sql: z
        .string()
        .describe('One SELECT statement against a table that data source has, e.g. SELECT * FROM orders LIMIT 100'),
    }),
  ]),
});

// Planning-time only. It is the *plan* that must not contain a CreateTable against an
// external source (ADR-0018); a CreateQuery step has no CreateTable to propose, so telling it
// the same thing is noise in a prompt that already carries the whole PRD.
const NO_TABLES_IN_EXTERNAL_SOURCES =
  'Tables can only be created in ToolJet DB — never plan a CreateTable step against one of these sources; query the tables it already has instead.';

// Both the planner and every CreateQuery step are grounded in the same connected-sources
// block, appended the same way, and neither gains anything when nothing is connected.
const withConnectedDataSources = (
  body: string,
  dataSources: QueryableDataSource[],
  { forPlanning = false }: { forPlanning?: boolean } = {}
): string => {
  const connectedSources = renderConnectedDataSources(dataSources);
  if (!connectedSources) return body;

  return [body, connectedSources, ...(forPlanning ? [NO_TABLES_IN_EXTERNAL_SOURCES] : [])].join('\n\n');
};

// SQL keywords that must not appear in a generated query. The tool schema and the prompt both
// ask for one SELECT, and nothing in this flow runs the statement to find out what it really
// is — a stored DELETE or DROP would sit in the app until a user pressed Run, and then it
// would be their data. ADR-0019 declines to validate what a statement *means*; this only
// checks what kind of statement it is, which is cheap and does not require running anything.
//
// `SELECT ... FOR UPDATE` is caught by this too. That is the intended reading: a query the
// AI wrote to feed a Table widget has no business taking row locks.
const WRITE_STATEMENT_KEYWORDS =
  /\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|call|do|copy|vacuum|comment)\b/i;

const isSingleReadOnlyStatement = (sql: string): boolean => {
  const stripped = (sql || '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '')
    .trim();

  if (!stripped) return false;
  // A second statement after the first is how a read turns into a write without the opening
  // keyword ever changing.
  if (stripped.includes(';')) return false;
  if (!/^(select|with)\b/i.test(stripped)) return false;
  return !WRITE_STATEMENT_KEYWORDS.test(stripped);
};

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
  description: 'Propose a corrected value for the failing component property.',
  parameters: z.object({
    fixedValue: z.string().describe('The complete replacement value for the property field, written verbatim into it'),
    explanation: z.string().describe('One short plain-language sentence explaining what was wrong'),
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
  description: 'Return the complete query body the user described.',
  parameters: z.object({
    code: z.string().describe("The complete replacement body for the editor, in the editor's language"),
    explanation: z.string().describe('One short plain-language sentence about what the code does'),
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
const SUPPORTED_COPILOT_LANGUAGES = ['javascript', 'python'];
const DEFAULT_COPILOT_LANGUAGE = 'javascript';

// The fallback value arrives as parsed JSON from the request body, so it can't be circular —
// but it can be large (a whole query result standing in for a Table's `data`), and a fix
// prompt has no reason to carry more than enough of it to show the expected shape.
const FALLBACK_VALUE_PROMPT_LIMIT = 500;

const isNonEmptyString = (value: any): value is string => typeof value === 'string' && value.trim().length > 0;

const isCodeTooLongToShow = (code: string): boolean => code.length > CURRENT_CODE_PROMPT_LIMIT;

const summarizeFallbackValue = (value: any): string => {
  const serialized = JSON.stringify(value) ?? String(value);
  return serialized.length > FALLBACK_VALUE_PROMPT_LIMIT
    ? `${serialized.slice(0, FALLBACK_VALUE_PROMPT_LIMIT)}… (truncated)`
    : serialized;
};

type StepExecutionContext = {
  prd: string;
  organizationId: string;
  appVersionId: string;
  priorResults: Array<{ type: StepType; artifact: Artifact }>;
  // Assembled once per approval, not per step: reading it opens a real connection to each
  // connected source, and the answer cannot change while a plan is being executed.
  dataSources: QueryableDataSource[];
};

@Injectable()
export class AiService implements IAiService {
  private readonly logger = new Logger(AiService.name);

  private readonly SUPPORTED_STEP_TYPES: StepType[] = ['CreateTable', 'CreateComponent', 'CreateQuery'];
  private readonly MAX_STEP_ATTEMPTS = 3; // 1 initial attempt + 2 retries, per ticket acceptance criteria

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
    private readonly dataSourceInventoryService: DataSourceInventoryService
  ) {}

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
    userId: string
  ): Promise<AiConversation> {
    const conversation = await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }
    if (conversation.conversationType !== expectedType) {
      throw new BadRequestException(
        `This action is only available in a "${expectedType}" conversation, but this one is "${conversation.conversationType}"`
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
    const name = firstName || 'there';

    return {
      user: {
        name,
        greeting: `Hi ${name}, what would you like to build today?`,
        description: 'Describe your app idea and I will help you turn it into a working ToolJet app.',
      },
      suggestions: [
        {
          icon: 'inventory',
          label: 'Inventory tracker',
          action: 'Build an inventory tracker for a small warehouse with low-stock alerts.',
        },
        {
          icon: 'crm',
          label: 'Customer CRM',
          action: 'Build a simple CRM to track leads, contacts, and deal stages.',
        },
        {
          icon: 'dashboard',
          label: 'Support dashboard',
          action: 'Build a support ticket dashboard for my team with status filters.',
        },
        {
          icon: 'form',
          label: 'Approval workflow',
          action: 'Build an approval workflow for employee expense requests.',
        },
      ],
    };
  }

  /**
   * Upserts the single vote row for `messageId` (ADR-0009: AiResponseVote is a OneToOne
   * off AiConversationMessage, one row per message — not per user, so a second vote just
   * overwrites the first rather than creating a duplicate).
   */
  async voteAiMessage(messageId: string, voteType: string, userId: string): Promise<any> {
    if (!messageId || !voteType) {
      throw new BadRequestException('messageId and voteType are required');
    }
    if (voteType !== 'up' && voteType !== 'down') {
      throw new BadRequestException('voteType must be "up" or "down"');
    }

    const message = await this.aiConversationMessageRepository.findMessageById(messageId);
    if (!message) {
      throw new NotFoundException('Message not found');
    }

    // A vote is written against a conversation, so ownership is verified through it even though
    // the endpoint takes the message id directly (otherwise knowing a message UUID lets any user
    // attach a vote row to someone else's thread).
    const conversation = await this.aiConversationRepository.findById(message.aiConversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Message not found');
    }

    const vote = voteType as 'up' | 'down';
    const existingVote = await this.aiResponseVoteRepository.findByMessageId(messageId);
    if (existingVote) {
      await this.aiResponseVoteRepository.updateOne(existingVote.id, { voteType: vote, userId });
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
    dataSourceId?: string
  ): Promise<any> {
    if (!conversationId || !prd) {
      throw new BadRequestException('conversationId and prd are required');
    }
    const organizationId = user.organizationId;

    // Raised before any SSE header is written, so a Learn conversation's caller gets a real
    // non-2xx + JSON body (which the client's `onopen` handler surfaces) rather than a stream
    // that opens and then immediately errors.
    const conversation = await this.loadConversationOfType(conversationId, 'generate', user.id);

    const conversationMessages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);
    const prdMessage = [...conversationMessages].reverse().find((message) => message.messageType === 'ai');
    if (!prdMessage) {
      throw new BadRequestException('No PRD message found to approve');
    }

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    try {
      const appVersionId = await this.resolveAppVersionId(conversation.appId);
      const dataSources = await this.dataSourceInventoryService.listQueryableSources(user, userPermissions);
      // Ticket #20: Steps persisted by an earlier previewPlan call for this same PRD message
      // are reused as-is — what the user previewed (including each CreateTable step's planned
      // table definition) is exactly what executes. A PRD refined after the preview produces a
      // new AI message, whose (empty) pending set falls through to a fresh plan.
      const steps = await this.resolvePlanForPrdMessage(conversationId, prdMessage, organizationId, dataSources, prd);
      // ADR-0018: when the user explicitly selects an external source, CreateTable steps
      // (which only make sense against ToolJet DB) are stripped from the plan before it is
      // persisted or executed. The planner is also told this constraint via the connected-
      // sources block, but the filter is the safety net — the planner can still propose one
      // in edge cases (e.g. when the prompt is long and the constraint is buried).
      const filteredSteps = dataSourceId ? steps.filter((step) => step.type !== 'CreateTable') : steps;

      this.aiUtilService.sendSSE(response, 'plan', { steps: this.mapStepsForWire(filteredSteps) });

      const context: StepExecutionContext = { prd, organizationId, appVersionId, priorResults: [], dataSources };

      for (let index = 0; index < filteredSteps.length; index++) {
        const step = filteredSteps[index];
        // Ticket #21: skip is checkpoint-based — a step the user skipped (while it was
        // pending, e.g. during an earlier step's execution) is detected here and never
        // starts, so no Artifact is made for it.
        if ((await this.stepRepository.findById(step.id))?.status === 'skipped') {
          this.sendStepSkippedSSE(response, index, filteredSteps.length, step.description);
          continue;
        }
        await this.stepRepository.updateOne(step.id, { status: 'running' });
        this.aiUtilService.sendSSE(response, 'step-progress', {
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
        if (outcome.skipped || (await this.stepRepository.findById(step.id))?.status === 'skipped') {
          if (outcome.success && outcome.artifact) {
            await this.discardStepArtifact(step, appVersionId, organizationId, outcome.artifact);
          }
          this.sendStepSkippedSSE(response, index, filteredSteps.length, step.description);
          continue;
        }

        if (outcome.success) {
          context.priorResults.push({ type: step.type, artifact: outcome.artifact });
          this.aiUtilService.sendSSE(response, 'step-done', {
            step: index + 1,
            of: filteredSteps.length,
            artifact: outcome.artifact,
          });
          continue;
        }

        const failureMessage = await this.aiConversationMessageRepository.createOne({
          aiConversationId: conversationId,
          messageType: 'ai',
          content: `The build stopped at step ${index + 1} of ${filteredSteps.length} ("${step.description}"): ${outcome.errorMessage}`,
          parentId: prdMessage.id,
          isLatest: true,
        });
        this.aiUtilService.sendSSE(response, 'step-failed', {
          step: index + 1,
          of: filteredSteps.length,
          message: outcome.errorMessage,
        });
        this.aiUtilService.sendSSE(response, 'done', {
          message: failureMessage,
          succeeded: context.priorResults.length,
          total: filteredSteps.length,
        });
        response.end();
        return;
      }

      this.aiUtilService.sendSSE(response, 'done', {
        succeeded: context.priorResults.length,
        total: filteredSteps.length,
      });
      response.end();
    } catch (error) {
      this.logger.error(`[approvePrd] conversationId=${conversationId} failed: ${error?.message}`, error?.stack);
      this.aiUtilService.sendSSE(response, 'error', { message: error?.message || 'Failed to build the plan' });
      response.end();
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
  async previewPlan(conversationId: string, user: User, userPermissions: UserPermissions, dataSourceId?: string) {
    if (!conversationId) {
      throw new BadRequestException('conversationId is required');
    }
    // Same rules as approvePrd: generate conversations only, caller-owned, PRD message required.
    await this.loadConversationOfType(conversationId, 'generate', user.id);

    const organizationId = user.organizationId;
    const conversationMessages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);
    const prdMessage = [...conversationMessages].reverse().find((message) => message.messageType === 'ai');
    if (!prdMessage) {
      throw new BadRequestException('No PRD message found to plan from');
    }

    const dataSources = await this.dataSourceInventoryService.listQueryableSources(user, userPermissions);
    const steps = await this.resolvePlanForPrdMessage(conversationId, prdMessage, organizationId, dataSources);

    // Same ADR-0018 safety net as approvePrd: with an external source selected, CreateTable
    // steps (and their planned tables) are stripped from what the preview shows.
    const filteredSteps = dataSourceId ? steps.filter((step) => step.type !== 'CreateTable') : steps;
    return { steps: this.mapStepsForWire(filteredSteps) };
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
    prd?: string
  ): Promise<Step[]> {
    let steps = await this.stepRepository.findPendingForMessage(conversationId, prdMessage.id);
    if (!steps.length) {
      steps = await this.generateStepPlan(
        prd ?? prdMessage.content,
        conversationId,
        prdMessage.id,
        organizationId,
        dataSources
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
      throw new Error('This app has no version to work with');
    }
    const sorted = [...versions].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return sorted[0].id;
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
    dataSources: QueryableDataSource[]
  ): Promise<Step[]> {
    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-plan',
      {
        system: STEP_PLAN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: withConnectedDataSources(prd, dataSources, { forPlanning: true }) }],
        tools: { proposeStepPlan: proposeStepPlanTool },
        toolChoice: { type: 'tool', toolName: 'proposeStepPlan' },
      },
      organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'proposeStepPlan') {
      throw new Error('The assistant did not propose a build plan');
    }

    const { steps: proposedSteps } = call.args as {
      steps: Array<{ type: StepType; description: string; table?: TableDefinition; seed_rows?: any[]; phase?: string }>;
    };
    if (!proposedSteps?.length) {
      throw new Error('The assistant proposed an empty build plan');
    }

    const persisted: Step[] = [];
    for (let index = 0; index < proposedSteps.length; index++) {
      const proposed = proposedSteps[index];
      // Ticket #20: a CreateTable step carries its concrete proposed definition, which the
      // schema preview renders and executeCreateTableStep later creates verbatim. A
      // malformed one is dropped rather than persisted — execution then falls back to the
      // per-step LLM path instead of trusting a half-formed contract.
      const plannedTable =
        proposed.type === 'CreateTable' && isWellFormedTableDefinition(proposed.table) ? proposed.table : undefined;
      // Ticket #48: seed rows ride on the same CreateTable steps, dropped when malformed —
      // execution then creates the table without seeding instead of trusting a half-formed
      // contract (same policy as a malformed planned table). Malformed includes rows that
      // name columns the planned table doesn't have: the spec's "INSERTs consistent with
      // the planned schema" is checked here, against the planner's own table proposal, so
      // a hallucinated column fails at plan time (the preview never shows it) rather than
      // mid-execution. Rows are only trusted when the table definition they seed is too.
      const plannedSeedRows =
        proposed.type === 'CreateTable' &&
        isWellFormedTableDefinition(proposed.table) &&
        isWellFormedSeedRows(proposed.seed_rows) &&
        areSeedRowsConsistentWithTable(proposed.seed_rows, proposed.table)
          ? proposed.seed_rows
          : undefined;
      // Ticket #21: the planner-assigned phase name, trimmed; an absent/blank one persists
      // as null so the client's fallback grouping sees a consistent shape.
      const phase = proposed.phase?.trim() || null;
      const step = await this.stepRepository.createOne({
        conversationId,
        messageId,
        order: index,
        type: proposed.type,
        description: proposed.description,
        ...(plannedTable && { plannedTable }),
        ...(plannedSeedRows && { plannedSeedRows }),
        ...(phase && { phase }),
        status: 'pending',
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
    context: StepExecutionContext
  ): Promise<{ success: boolean; artifact?: Artifact; errorMessage?: string; skipped?: boolean }> {
    if (!this.SUPPORTED_STEP_TYPES.includes(step.type)) {
      const errorMessage = `Unsupported step type "${step.type}" — not yet implemented`;
      await this.stepRepository.updateOne(step.id, { status: 'failed', errorMessage });
      return { success: false, errorMessage };
    }

    let lastError: string;
    for (let attempt = 1; attempt <= this.MAX_STEP_ATTEMPTS; attempt++) {
      try {
        const { content, identifier, props } = await this.executeStep(step, context, lastError);

        // Ticket #21: a step the user skipped mid-run must not be recorded with either
        // terminal status — the execution loop owns that transition (step-skipped), and
        // overwriting 'skipped' with 'succeeded'/'failed' here would make the skip silently
        // vanish. The Artifact row is still created, so the loop can undo the real change
        // this attempt already made before discarding it.
        const skipped = (await this.stepRepository.findById(step.id))?.status === 'skipped';
        const artifact = await this.artifactRepository.createOne({
          conversationId: step.conversationId,
          messageId: step.messageId,
          content,
          identifier,
        });
        await this.stepRepository.updateOne(step.id, {
          ...(skipped ? {} : { status: 'succeeded' }),
          props,
          attempts: attempt,
          artifactId: artifact.id,
        });
        return { success: true, artifact, skipped };
      } catch (error) {
        lastError = error?.message || 'Step execution failed';
        this.logger.warn(`[approvePrd] step=${step.id} type=${step.type} attempt=${attempt} failed: ${lastError}`);
        await this.stepRepository.updateOne(step.id, { attempts: attempt, errorMessage: lastError });
      }
    }

    // Same guard on the failed terminal write: a step skipped while its retries ran is
    // reported back as skipped, not failed — the plan continues instead of stopping.
    const skipped = (await this.stepRepository.findById(step.id))?.status === 'skipped';
    if (!skipped) {
      await this.stepRepository.updateOne(step.id, { status: 'failed', errorMessage: lastError });
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
    artifact: Artifact
  ): Promise<void> {
    await this.agentsService.undoArtifact(step.type, appVersionId, organizationId, artifact.content);
    await this.artifactRepository.deleteOne(artifact.id);
    await this.stepRepository.updateOne(step.id, { artifactId: null });
  }

  private sendStepSkippedSSE(response: Response, index: number, of: number, description: string): void {
    this.aiUtilService.sendSSE(response, 'step-skipped', { step: index + 1, of, description });
  }

  private async executeStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    switch (step.type) {
      case 'CreateTable':
        return this.executeCreateTableStep(step, context, previousError);
      case 'CreateComponent':
        return this.executeComponentStep(step, context, previousError);
      case 'CreateQuery':
        return this.executeQueryStep(step, context, previousError);
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
  private buildStepContextLines(step: Step, context: StepExecutionContext, previousError?: string): string {
    const lines = [`PRD:\n${context.prd}`, `Step to build: ${step.description}`];
    if (context.priorResults.length) {
      const summary = context.priorResults
        .map((result) => `- ${result.type} → ${JSON.stringify(result.artifact.content)}`)
        .join('\n');
      lines.push(
        `Already created earlier in this plan (reference real ids/names from here, never invent one):\n${summary}`
      );
    }
    if (previousError) {
      lines.push(`The previous attempt failed with: "${previousError}". Fix the issue and try again.`);
    }
    return lines.join('\n\n');
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
    };
  }

  async executeCreateTableStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    // Ticket #20: a planned table persisted by the planner is the contract — it is created
    // verbatim with no LLM call, so what the pre-approval schema preview showed is exactly
    // what gets created. Steps without a well-formed planned table (plans persisted before
    // #20, or a malformed definition dropped at plan time) fall through to the LLM path.
    if (isWellFormedTableDefinition(step.plannedTable)) {
      const tableParams = this.buildTableParams(step.plannedTable);
      const created = await this.agentsService.CreateTable(context.organizationId, tableParams);
      // Ticket #48: seed rows the planner proposed (and the preview showed) are inserted
      // here, right after the table exists — same deterministic, no-LLM contract as the
      // table itself. A failure throws into the retry loop like any other step error.
      let seed: { inserted: number; updated: number } | undefined;
      if (isWellFormedSeedRows(step.plannedSeedRows)) {
        const primaryKeyColumns = step.plannedTable.columns
          .filter((column: any) => column.is_primary_key)
          .map((column: any) => column.column_name);
        seed = await this.agentsService.SeedTable(
          context.organizationId,
          created.id,
          primaryKeyColumns,
          step.plannedSeedRows
        );
      }
      return {
        content: { ...created, columns: tableParams.columns, ...(seed && { seed }) },
        identifier: created.table_name,
        props: tableParams,
      };
    }

    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-create-table',
      {
        system: CREATE_TABLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.buildStepContextLines(step, context, previousError) }],
        tools: { createTable: createTableTool },
        toolChoice: { type: 'tool', toolName: 'createTable' },
      },
      context.organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'createTable') {
      throw new Error('The assistant did not produce a table definition');
    }

    const args = call.args as TableDefinition;
    const tableParams = this.buildTableParams(args);

    const created = await this.agentsService.CreateTable(context.organizationId, tableParams);

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

  private async executeComponentStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-create-component',
      {
        system: CREATE_COMPONENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.buildStepContextLines(step, context, previousError) }],
        tools: { createComponent: createComponentTool },
        toolChoice: { type: 'tool', toolName: 'createComponent' },
      },
      context.organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'createComponent') {
      throw new Error('The assistant did not produce a component definition');
    }

    const { type, ...props } = call.args as { type: string; [key: string]: any };
    if (!(SUPPORTED_COMPONENT_TYPES as readonly string[]).includes(type)) {
      // Retryable, unlike an unsupported Step type: the model chooses `type` per attempt.
      throw new Error(
        `Unsupported component type "${type}" — supported types are: ${SUPPORTED_COMPONENT_TYPES.join(', ')}`
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
          result.type === 'CreateComponent' &&
          result.artifact.content?.id === props.pageId &&
          result.artifact.content?.pageId === undefined
      );
      if (!pageExists) {
        throw new Error(`pageId "${props.pageId}" does not match any Page created earlier in this plan`);
      }
    }

    if (type === 'Table') {
      const queryExists = context.priorResults.some(
        (result) => result.type === 'CreateQuery' && result.artifact.content?.name === props.queryName
      );
      if (!queryExists) {
        throw new Error(`queryName "${props.queryName}" does not match any query created earlier in this plan`);
      }
    }

    if (type === 'Form') {
      const tableResult = context.priorResults.find(
        (result) => result.type === 'CreateTable' && result.artifact.content?.id === props.tableId
      );
      if (!tableResult) {
        throw new Error(`tableId "${props.tableId}" does not match any table created earlier in this plan`);
      }
      // AgentsService.createFormComponent needs the table's real columns (to build the
      // form's fields) — only available from the CreateTable step's Artifact content.
      props.columns = tableResult.artifact.content.columns;

      // An edit-mode Form binds its fields and its update_rows identity filter to another
      // Table widget's selectedRow, so that Table must actually exist in this plan AND be
      // bound (via the query it displays) to the same underlying ToolJet DB table this
      // form edits. Both are retryable failures — the model picks the name/id per attempt,
      // and the error names what it was actually offered so the next attempt can correct.
      if (props.mode === 'edit') {
        if (!props.tableName) {
          throw new Error('An edit-mode Form must reference a Table widget (tableName) to bind its selectedRow to');
        }
        const tableWidget = context.priorResults.find(
          (result) =>
            result.type === 'CreateComponent' &&
            result.artifact.content?.type === 'Table' &&
            result.artifact.content?.name === props.tableName
        );
        if (!tableWidget) {
          throw new Error(
            `tableName "${props.tableName}" does not match any Table widget created earlier in this plan`
          );
        }
        const boundQuery = context.priorResults.find(
          (result) =>
            result.type === 'CreateQuery' && result.artifact.content?.name === tableWidget.artifact.content?.queryName
        );
        if (!boundQuery || boundQuery.artifact.content?.options?.table_id !== props.tableId) {
          throw new Error(
            `Table "${props.tableName}" is not bound to the same ToolJet DB table (${props.tableId}) this edit-mode form edits`
          );
        }
      }
    }

    const created = await this.agentsService.CreateComponent(context.appVersionId, context.organizationId, type, props);

    return { content: created, identifier: created.id, props: { type, ...props } };
  }

  private async executeQueryStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    const stepContext = this.buildStepContextLines(step, context, previousError);

    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-create-query',
      {
        system: CREATE_QUERY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: withConnectedDataSources(stepContext, context.dataSources) }],
        tools: { createQuery: createQueryTool },
        toolChoice: { type: 'tool', toolName: 'createQuery' },
      },
      context.organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'createQuery') {
      throw new Error('The assistant did not produce a query definition');
    }

    const args = call.args as {
      source?: string;
      name: string;
      table_id?: string;
      data_source_id?: string;
      sql?: string;
    };
    const props =
      args.source === 'sql' ? this.buildExternalQueryProps(args, context) : this.buildTooljetDbQueryProps(args);

    const created = await this.agentsService.CreateQuery(context.appVersionId, context.organizationId, props);

    return { content: created, identifier: created.name, props };
  }

  /**
   * The default branch, and the only one that existed before ADR-0019 — which is why an
   * absent `source` lands here rather than being rejected: a plan the model writes without
   * naming a source is a ToolJet DB plan, exactly as it always was.
   */
  private buildTooljetDbQueryProps(args: { name: string; table_id?: string }) {
    return {
      name: args.name,
      options: { operation: 'list_rows', table_id: args.table_id, list_rows: { limit: 100 } },
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
  private buildExternalQueryProps(
    args: { name: string; data_source_id?: string; sql?: string },
    context: StepExecutionContext
  ) {
    if (!args.sql?.trim()) {
      throw new Error('An external data source query needs a SQL statement, but none was given');
    }
    if (!isSingleReadOnlyStatement(args.sql)) {
      throw new Error(
        `The query must be a single read-only SELECT statement against ${'`'}${args.data_source_id}${'`'}, but it was: ${args.sql}`
      );
    }

    const dataSource = context.dataSources.find((candidate) => candidate.id === args.data_source_id);
    if (!dataSource) {
      const available = context.dataSources.length
        ? context.dataSources.map((candidate) => `${candidate.name} (${candidate.id})`).join(', ')
        : 'none — this app has no connected data source, so the query must target ToolJet DB';
      throw new Error(
        `data_source_id "${args.data_source_id}" does not match any connected data source. Available: ${available}`
      );
    }

    return {
      name: args.name,
      dataSourceId: dataSource.id,
      options: { mode: 'sql', query: args.sql },
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
    const lines = references
      .filter(
        (reference) =>
          reference &&
          typeof reference === 'object' &&
          ['page', 'component', 'query'].includes(reference.type) &&
          typeof reference.id === 'string' &&
          reference.id.trim() &&
          typeof reference.name === 'string' &&
          reference.name.trim()
      )
      .map((reference) => {
        const details: string[] = [];
        if (reference.type === 'component') {
          if (reference.widgetType) details.push(`${reference.widgetType} widget`);
          if (reference.pageName) details.push(`on page "${reference.pageName}"`);
        } else if (reference.type === 'query' && reference.kind) {
          details.push(`kind: ${reference.kind}`);
        }
        const suffix = details.length ? ` (${details.join(', ')})` : '';
        return `- @${reference.name} — ${reference.type}${suffix}, id: ${reference.id}`;
      });
    if (!lines.length) return null;
    return [
      'The user @-mentioned resources in this message. Each @name below refers to exactly this object:',
      ...lines,
    ].join('\n');
  }

  /**
   * Shared PRD-conversation message shape both `sendUserMessage` and `regenerateAiMessage`
   * feed to the LLM: the system prompt, `priorMessages` mapped to role/content, and an
   * optional trailing user turn (sendUserMessage's new message — regenerateAiMessage has
   * none, since the user turn it's replying to is already the last entry in priorMessages).
   */
  private buildPrdMessages(priorMessages: AiConversationMessage[], trailingUserContent?: string, referencesContext?: string | null) {
    return [
      { role: 'system', content: PRD_SYSTEM_PROMPT },
      ...(referencesContext ? [{ role: 'system', content: referencesContext }] : []),
      ...priorMessages.map((message) => ({
        role: message.messageType === 'user' ? 'user' : 'assistant',
        content: message.content,
      })),
      ...(trailingUserContent ? [{ role: 'user', content: trailingUserContent }] : []),
    ];
  }

  /**
   * Loads/validates the conversation, persists the user's message, streams the
   * assistant's reply from AIGateway over SSE, then persists the full reply as
   * a new AiConversationMessage and closes the stream with a `done` event.
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
    organizationId: string
  ): Promise<any> {
    const { conversationId, content, references } = body ?? ({} as typeof body);

    if (!conversationId || !content) {
      throw new BadRequestException('conversationId and content are required');
    }

    // Generate-only, the mirror of sendUserDocsMessage being Learn-only: this path answers
    // with a PRD, and a PRD in a Learn conversation could never be approved (approvePrd
    // refuses one), so it would be a proposal with no way to act on it.
    await this.loadConversationOfType(conversationId, 'generate', userId);

    // Conversation history precedes the new user message; it's fetched before
    // persisting so the new message isn't accidentally double-counted.
    const priorMessages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);

    const userMessage = await this.aiConversationMessageRepository.createOne({
      aiConversationId: conversationId,
      messageType: 'user',
      content,
      references: references ?? null,
      isLatest: true,
    });

    const messages = this.buildPrdMessages(priorMessages, content, this.buildMentionedResourcesContext(references));

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    let fullText = '';

    try {
      const result = await this.aiUtilService.AIGateway('openai', 'send-message', { messages }, organizationId);

      for await (const chunk of result.textStream) {
        fullText += chunk;
        this.aiUtilService.sendSSE(response, 'chunk', { content: chunk });
      }

      const aiMessage = await this.aiConversationMessageRepository.createOne({
        aiConversationId: conversationId,
        messageType: 'ai',
        content: fullText,
        parentId: userMessage.id,
        isLatest: true,
      });

      this.aiUtilService.sendSSE(response, 'done', { message: aiMessage });
      response.end();
    } catch (error) {
      this.logger.error(`[sendUserMessage] conversationId=${conversationId} failed: ${error?.message}`, error?.stack);
      this.aiUtilService.sendSSE(response, 'error', { message: error?.message || 'Something went wrong' });
      response.end();
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
    referencesContext?: string | null
  ) {
    return [
      { role: 'system', content: LEARN_SYSTEM_PROMPT },
      { role: 'system', content: `App inventory (current, assembled just now):\n\n${inventory}` },
      ...(referencesContext ? [{ role: 'system', content: referencesContext }] : []),
      ...priorMessages.map((message) => ({
        role: message.messageType === 'user' ? 'user' : 'assistant',
        content: message.content,
      })),
      ...(trailingUserContent ? [{ role: 'user', content: trailingUserContent }] : []),
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
    organizationId: string
  ): Promise<any> {
    const { conversationId, content, references } = body ?? ({} as typeof body);

    if (!conversationId || !content) {
      throw new BadRequestException('conversationId and content are required');
    }

    const conversation = await this.loadConversationOfType(conversationId, 'learn', userId);

    const priorMessages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);

    const userMessage = await this.aiConversationMessageRepository.createOne({
      aiConversationId: conversationId,
      messageType: 'user',
      content,
      references: references ?? null,
      isLatest: true,
    });

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    let fullText = '';

    try {
      const inventory = await this.assembleAppInventory(conversation.appId);
      const messages = this.buildLearnMessages(
        inventory,
        priorMessages,
        content,
        this.buildMentionedResourcesContext(references)
      );

      const result = await this.aiUtilService.AIGateway('openai', 'send-docs-message', { messages }, organizationId);

      for await (const chunk of result.textStream) {
        fullText += chunk;
        this.aiUtilService.sendSSE(response, 'chunk', { content: chunk });
      }

      const aiMessage = await this.aiConversationMessageRepository.createOne({
        aiConversationId: conversationId,
        messageType: 'ai',
        content: fullText,
        parentId: userMessage.id,
        isLatest: true,
      });

      this.aiUtilService.sendSSE(response, 'done', { message: aiMessage });
      response.end();
    } catch (error) {
      this.logger.error(
        `[sendUserDocsMessage] conversationId=${conversationId} failed: ${error?.message}`,
        error?.stack
      );
      this.aiUtilService.sendSSE(response, 'error', { message: error?.message || 'Something went wrong' });
      response.end();
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
  async promoteConversation(conversationId: string, messageId: string, userId: string): Promise<any> {
    if (!conversationId) {
      throw new BadRequestException('conversationId is required');
    }

    const conversation = await this.loadConversationOfType(conversationId, 'learn', userId);

    const messages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);
    const answer = messageId
      ? messages.find((message) => message.id === messageId && message.messageType === 'ai')
      : [...messages].reverse().find((message) => message.messageType === 'ai');
    if (!answer) {
      throw new BadRequestException('No answer to promote in this conversation');
    }

    const question = messages.find((message) => message.id === answer.parentId);

    const generateConversation = await this.aiUtilService.createNewConversation(
      userId,
      conversation.appId,
      'generate',
      undefined,
      true
    );

    // Recorded alongside `handoff` so the originating thread stays traceable from the new one —
    // the two conversations are otherwise unrelated rows, which is exactly ADR-0012's point.
    const metadata = { ...(generateConversation.metadata || {}), promotedFromConversationId: conversationId };
    await this.aiConversationRepository.updateOne(generateConversation.id, { metadata });
    generateConversation.metadata = metadata;

    const seedMessage = await this.aiConversationMessageRepository.createOne({
      aiConversationId: generateConversation.id,
      messageType: 'user',
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
      (text || '').trim().length > MAX_SEED_PART_CHARS
        ? `${(text || '').trim().slice(0, MAX_SEED_PART_CHARS)}…`
        : (text || '').trim();

    return [
      'Context carried over from a Learn conversation about this app:',
      '',
      ...(question ? [`Question: ${condense(question)}`, ''] : []),
      `Answer: ${condense(answer)}`,
      '',
      'I want to build on this.',
    ].join('\n');
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
    inclusive = false
  ): Promise<any> {
    if (!conversationId || !stepId) {
      throw new BadRequestException('conversationId and stepId are required');
    }

    const conversation = await this.loadConversationOfType(conversationId, 'generate', userId);

    const targetStep = await this.stepRepository.findById(stepId);
    if (!targetStep || targetStep.conversationId !== conversationId) {
      throw new NotFoundException('Step not found in this conversation');
    }
    if (targetStep.status !== 'succeeded') {
      throw new BadRequestException('Can only rewind to a completed step');
    }

    const appVersionId = await this.resolveAppVersionId(conversation.appId);
    const stepsAfter = await this.stepRepository.findAfterOrder(conversationId, targetStep.messageId, targetStep.order);
    const stepsToUndo = inclusive ? [targetStep, ...stepsAfter] : stepsAfter;

    for (const step of [...stepsToUndo].reverse()) {
      if (step.status === 'succeeded' && step.artifactId) {
        const artifact = await this.artifactRepository.findById(step.artifactId);
        if (artifact) {
          await this.agentsService.undoArtifact(step.type, appVersionId, organizationId, artifact.content);
          await this.artifactRepository.deleteOne(artifact.id);
        }
      }
      await this.stepRepository.updateOne(step.id, {
        status: 'pending',
        artifactId: null,
        errorMessage: null,
        attempts: 0,
      });
    }

    return { rewoundTo: targetStep.id, undone: stepsToUndo.map((step) => step.id) };
  }

  /**
   * Marks one Step of a running plan as skipped (ticket #21). Not a streaming endpoint and
   * not an executor: it only records the user's decision; approvePrd's execution loop acts
   * on it at its next checkpoint. A pending step is skipped before it ever starts; a running
   * one finishes its in-flight LLM call and then has its outcome discarded (and any Artifact
   * it already produced undone) by the loop. Failed steps can't be skipped — a failed plan
   * has already stopped, and retrying it is rewind + re-approve, not skip.
   */
  async skipStep(conversationId: string, stepId: string, userId: string): Promise<any> {
    if (!conversationId || !stepId) {
      throw new BadRequestException('conversationId and stepId are required');
    }

    await this.loadConversationOfType(conversationId, 'generate', userId);

    const step = await this.stepRepository.findById(stepId);
    if (!step || step.conversationId !== conversationId) {
      throw new NotFoundException('Step not found in this conversation');
    }
    if (step.status !== 'pending' && step.status !== 'running') {
      throw new BadRequestException('Only a pending or running step can be skipped');
    }

    await this.stepRepository.updateOne(step.id, { status: 'skipped' });
    return { skipped: step.id };
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
  async regenerateAiMessage(parentMessageId: string, userId: string, organizationId: string): Promise<any> {
    if (!parentMessageId) {
      throw new BadRequestException('parentMessageId is required');
    }

    const parentMessage = await this.aiConversationMessageRepository.findMessageById(parentMessageId);
    if (!parentMessage) {
      throw new NotFoundException('Message not found');
    }

    const conversationId = parentMessage.aiConversationId;
    // Regeneration reads the target conversation's history and re-runs an LLM call grounded in
    // it, so ownership is enforced up front — otherwise a known message UUID lets any user
    // consume AI credits and read/mutate a thread that isn't theirs.
    const conversation = await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }
    const latestMessages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);
    const parentIndex = latestMessages.findIndex((message) => message.id === parentMessageId);
    if (parentIndex === -1) {
      throw new BadRequestException('Message is not part of the active conversation branch');
    }

    const staleReply = latestMessages[parentIndex + 1];
    if (!staleReply || staleReply.parentId !== parentMessageId || staleReply.messageType !== 'ai') {
      throw new BadRequestException('No AI reply to regenerate for this message');
    }
    if (parentIndex + 1 !== latestMessages.length - 1) {
      throw new BadRequestException('Only the latest message in the conversation can be regenerated');
    }

    const priorMessages = latestMessages.slice(0, parentIndex + 1);
    // Regenerate works identically for both conversation types, but "the same history the
    // original reply was generated from" means a different prompt in each: a Learn reply came
    // from the Learn prompt plus an App inventory, and regenerating it against the PRD prompt
    // would silently turn a Q&A answer into a build proposal. The inventory is re-assembled
    // rather than reused (ADR-0011) — the App may well have changed since the first attempt.
    const messages =
      conversation?.conversationType === 'learn'
        ? this.buildLearnMessages(await this.assembleAppInventory(conversation.appId), priorMessages)
        : this.buildPrdMessages(priorMessages);

    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'regenerate-message',
      { messages },
      organizationId
    );

    await this.aiConversationMessageRepository.updateOne(staleReply.id, { isLatest: false });

    return await this.aiConversationMessageRepository.createOne({
      aiConversationId: conversationId,
      messageType: 'ai',
      content: result?.text || '',
      parentId: parentMessageId,
      isLatest: true,
    });
  }

  /**
   * Self-hosted CE has no credit accounting: the `ai` feature is unconditionally
   * enabled (see BASIC_PLAN_TERMS.features.ai) and usage is unlimited, so this
   * never touches organization_ai_credit_history / selfhost_ai_credit_history.
   */
  async getCreditsBalance(organizationId): Promise<{ aiFeaturesEnabled: boolean; error?: string }> {
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
    if (!conversationType) return 'generate';
    if (!(CONVERSATION_TYPES as readonly string[]).includes(conversationType)) {
      throw new BadRequestException(
        `Unsupported conversationType "${conversationType}" — supported types are: ${CONVERSATION_TYPES.join(', ')}`
      );
    }
    return conversationType as ConversationType;
  }

  async listConversations(appId: string, userId: string, conversationType: string): Promise<any> {
    return this.aiUtilService.getConversationsList(appId, userId, this.resolveConversationType(conversationType));
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
    handoff?: boolean
  ): Promise<any> {
    return this.aiUtilService.createNewConversation(
      userId,
      appId,
      this.resolveConversationType(conversationType),
      currentConversationId,
      handoff
    );
  }

  async getConversationById(conversationId: string, userId: string): Promise<any> {
    return this.aiUtilService.getConversationById(conversationId, userId);
  }

  async getThreadTokenUsage(conversationId: string, user: any): Promise<any> {
    throw new Error('Method not implemented.');
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
    const { expression, errorMessage, componentName, componentType, propertyName, fallbackValue } = context;
    const lines: string[] = [];

    if (componentName || componentType) {
      lines.push(`Component: ${[componentType, componentName].filter(Boolean).join(' ')}`);
    }
    if (propertyName) {
      lines.push(`Property: ${propertyName}`);
    }
    lines.push(`Failing expression: ${expression}`);
    lines.push(`Error reported by the app runtime: ${errorMessage}`);
    if (fallbackValue !== undefined) {
      lines.push(
        `The property fell back to this value, which shows the shape it expects: ${summarizeFallbackValue(
          fallbackValue
        )}`
      );
    }

    return lines.join('\n');
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
  async fixWithAi(body: ErrorContext, organizationId: string): Promise<Suggestion> {
    const { expression, errorMessage } = body ?? ({} as ErrorContext);

    // Type-checked, not just truthiness-checked: this endpoint takes a raw `@Body()`, and the
    // error a component reports isn't always a string — PreviewBox's own resolver can produce
    // an array of messages. A bare `.trim()` on one of those throws a TypeError, which would
    // surface to the user as a 500 "Internal server error" for what is really a bad request.
    if (!isNonEmptyString(expression)) {
      throw new BadRequestException('expression is required and must be a non-empty string');
    }
    if (!isNonEmptyString(errorMessage)) {
      throw new BadRequestException('errorMessage is required and must be a non-empty string');
    }

    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'fix-with-ai',
      {
        system: FIX_WITH_AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.buildFixContextLines(body) }],
        tools: { proposeFix: proposeFixTool },
        toolChoice: { type: 'tool', toolName: 'proposeFix' },
      },
      organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'proposeFix') {
      throw new Error('The assistant did not produce a fix');
    }

    const { fixedValue, explanation } = call.args as { fixedValue: string; explanation: string };
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
  private async assembleCopilotInventory(appId?: string): Promise<string | null> {
    if (!appId) return null;

    try {
      return await this.assembleAppInventory(appId);
    } catch (error) {
      this.logger.warn(
        `[copilot] appId=${appId} inventory unavailable, answering ungrounded: ${error?.message}`,
        error?.stack
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
  private buildCopilotContextLines(context: CopilotContext, inventory: string | null): string {
    const { prompt, currentCode, language, dataSourceKind } = context;
    const sections: string[] = [];

    sections.push(`Editor language: ${this.resolveCopilotLanguage(language)}`);
    if (isNonEmptyString(dataSourceKind)) {
      sections.push(`This query runs against a "${dataSourceKind}" data source.`);
    }
    if (inventory) {
      sections.push(`Inventory of the app being edited:\n${inventory}`);
    }
    if (isNonEmptyString(currentCode) && isCodeTooLongToShow(currentCode)) {
      sections.push(
        'The editor already contains a body too long to include here, so you cannot see it. Write only what was asked, as a self-contained body, and open your explanation by warning that it replaces the existing code rather than extending it.'
      );
    } else if (isNonEmptyString(currentCode)) {
      sections.push(`Already in the editor, which is the user's work in progress:\n${currentCode}`);
    } else {
      sections.push('The editor is empty.');
    }
    sections.push(`What the user asked for:\n${prompt.trim()}`);

    return sections.join('\n\n');
  }

  private resolveCopilotLanguage(language?: string): string {
    const normalized = (language || '').trim().toLowerCase();
    return SUPPORTED_COPILOT_LANGUAGES.includes(normalized) ? normalized : DEFAULT_COPILOT_LANGUAGE;
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
  async copilot(body: CopilotContext, organizationId: string): Promise<Completion> {
    const { prompt } = body ?? ({} as CopilotContext);

    if (!isNonEmptyString(prompt)) {
      throw new BadRequestException('prompt is required and must be a non-empty string');
    }

    const inventory = await this.assembleCopilotInventory(body.appId);

    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'copilot',
      {
        system: COPILOT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.buildCopilotContextLines(body, inventory) }],
        tools: { writeCode: writeCodeTool },
        toolChoice: { type: 'tool', toolName: 'writeCode' },
      },
      organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'writeCode') {
      throw new Error('The assistant did not produce any code');
    }

    const { code, explanation } = call.args as { code: string; explanation: string };
    return { code, explanation };
  }
}
