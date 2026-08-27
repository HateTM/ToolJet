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
import { VersionRepository } from '@modules/versions/repository';
import { Step, StepType } from '@entities/step.entity';
import { Artifact } from '@entities/artifact.entity';
import { AiConversation } from '@entities/ai_conversation.entity';
import { AiConversationMessage } from '@entities/ai_conversation_message.entity';
import { ErrorContext, Suggestion } from './types';

const CONVERSATION_TYPES = ['generate', 'learn'] as const;
type ConversationType = (typeof CONVERSATION_TYPES)[number];

// Grounds the assistant in the Generate-conversation contract (see CONTEXT.md's
// "PRD" entry and ADR-0001): a Generate conversation only ever proposes a PRD in
// chat — it must never claim to have changed the App, since nothing is built
// until the user approves it (a later ticket). v1 target types per ADR-0002.
const PRD_SYSTEM_PROMPT = `You are the AI Builder assistant for ToolJet, a low-code app platform.

Your job in this conversation is to help the user turn their app idea into a clear Product Requirements Document (PRD): a structured description of the app to build — its pages, and for each page the components (Page, Table, Form, Button, Text, TextInput, Container) and any data queries it needs.

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

const STEP_PLAN_SYSTEM_PROMPT = `You turn an approved Product Requirements Document (PRD) into an ordered build plan for a ToolJet app.

Call proposeStepPlan exactly once with the ordered list of steps needed to build what the PRD describes. Each step is one of:
- CreateTable: creates a ToolJet DB table.
- CreateQuery: creates a data query against a ToolJet DB table.
- CreateComponent: creates a UI element (a page or a widget on a page).

Order matters: a table must exist before a query reads from it, and a query before a component that uses it. Give each step a short, specific description of what it builds.`;

const proposeStepPlanTool = tool({
  description: 'Propose the ordered list of build steps for this PRD.',
  parameters: z.object({
    steps: z
      .array(
        z.object({
          type: z.enum(STEP_TYPES),
          description: z.string().describe('Short, specific description of what this step builds'),
        })
      )
      .min(1),
  }),
});

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

const CREATE_TABLE_SYSTEM_PROMPT = `You design the exact schema for one ToolJet DB table, based on the PRD and the specific step you've been asked to build.

Call createTable exactly once with the table's real name (snake_case) and its columns. Every table needs exactly one primary key column (usually an auto-generated "id" of type serial). Pick sensible, minimal columns that satisfy what this step describes — don't invent columns the PRD doesn't call for.`;

const createTableTool = tool({
  description: 'Create a ToolJet DB table with the given name and columns.',
  parameters: z.object({
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
  }),
});

// Full v1 allow-list as of this ticket (ADR-0002: Page, Table, Form, Button, Text,
// TextInput, Container). Unlike an unsupported *Step* type (ADR-0006, which can never
// succeed since no handler exists), an unsupported *component* type is retried: the model
// picks it per attempt, so a later retry can self-correct to a supported one.
const SUPPORTED_COMPONENT_TYPES = ['Page', 'Table', 'Button', 'Text', 'TextInput', 'Container', 'Form'] as const;

// Component types that place a widget on an existing Page — everything except 'Page'
// itself (which creates one). Used to validate `pageId` uniformly across all of them.
const PAGE_WIDGET_TYPES = ['Table', 'Button', 'Text', 'TextInput', 'Container', 'Form'] as const;

const CREATE_COMPONENT_SYSTEM_PROMPT = `You create one UI element for this step, based on the PRD and whatever earlier steps in this plan already created (listed below, if any).

Call createComponent exactly once. Supported component types: Page, Table, Button, Text, TextInput, Container, Form.
- Page: give it a short, specific name.
- Table: reference the id of a Page already created in this plan to place it on, give it a title, and reference the name of a query already created in this plan whose data it should display.
- Button: reference a Page id, give it a short label.
- Text: reference a Page id, give it the text to display.
- TextInput: reference a Page id, give it a label (and an optional placeholder).
- Container: reference a Page id, give it a short title.
- Form: reference a Page id, the id of a ToolJet DB table already created in this plan to create records in, and a form title. This produces a working create-record form — you don't need a separate query or event step for it.
Only reference pages/tables/queries that actually appear in the context below — never invent an id or name.`;

const createComponentTool = tool({
  description: 'Create a Page, or a widget (Table, Button, Text, TextInput, Container, Form) on an existing Page.',
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
        .describe('id of an already-created ToolJet DB table (from context) this form creates records in'),
      title: z.string().describe('Form title'),
    }),
  ]),
});

const CREATE_QUERY_SYSTEM_PROMPT = `You create one data query against a ToolJet DB table for this step, based on the PRD and the table(s) already created earlier in this plan (listed below).

Call createQuery exactly once with a short snake_case query name (components will reference it as {{queries.<name>.data}}) and the real id of the ToolJet DB table to list rows from — that id must come from context below, never invented.`;

const createQueryTool = tool({
  description: 'Create a query that lists rows from an existing ToolJet DB table.',
  parameters: z.object({
    name: z
      .string()
      .describe('snake_case query name, unique within this app — referenced elsewhere as {{queries.<name>.data}}'),
    table_id: z.string().describe('id of an already-created ToolJet DB table (from context)'),
  }),
});

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

// The fallback value arrives as parsed JSON from the request body, so it can't be circular —
// but it can be large (a whole query result standing in for a Table's `data`), and a fix
// prompt has no reason to carry more than enough of it to show the expected shape.
const FALLBACK_VALUE_PROMPT_LIMIT = 500;

const isNonEmptyString = (value: any): value is string => typeof value === 'string' && value.trim().length > 0;

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
    private readonly appInventoryService: AppInventoryService
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
  private async loadConversationOfType(
    conversationId: string,
    expectedType: ConversationType
  ): Promise<AiConversation> {
    const conversation = await this.aiConversationRepository.findById(conversationId);
    if (!conversation) {
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
   *  - `plan`         (once):     { steps: [{ id, type, description }] }
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
  async approvePrd(conversationId: string, prd: any, organizationId: string, response: Response): Promise<any> {
    if (!conversationId || !prd) {
      throw new BadRequestException('conversationId and prd are required');
    }

    // Raised before any SSE header is written, so a Learn conversation's caller gets a real
    // non-2xx + JSON body (which the client's `onopen` handler surfaces) rather than a stream
    // that opens and then immediately errors.
    const conversation = await this.loadConversationOfType(conversationId, 'generate');

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
      const steps = await this.generateStepPlan(prd, conversationId, prdMessage.id, organizationId);

      this.aiUtilService.sendSSE(response, 'plan', {
        steps: steps.map((step) => ({ id: step.id, type: step.type, description: step.description })),
      });

      const context: StepExecutionContext = { prd, organizationId, appVersionId, priorResults: [] };

      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        await this.stepRepository.updateOne(step.id, { status: 'running' });
        this.aiUtilService.sendSSE(response, 'step-progress', {
          step: index + 1,
          of: steps.length,
          description: step.description,
        });

        const outcome = await this.executeStepWithRetry(step, context);

        if (outcome.success) {
          context.priorResults.push({ type: step.type, artifact: outcome.artifact });
          this.aiUtilService.sendSSE(response, 'step-done', {
            step: index + 1,
            of: steps.length,
            artifact: outcome.artifact,
          });
          continue;
        }

        const failureMessage = await this.aiConversationMessageRepository.createOne({
          aiConversationId: conversationId,
          messageType: 'ai',
          content: `The build stopped at step ${index + 1} of ${steps.length} ("${step.description}"): ${outcome.errorMessage}`,
          parentId: prdMessage.id,
          isLatest: true,
        });
        this.aiUtilService.sendSSE(response, 'step-failed', {
          step: index + 1,
          of: steps.length,
          message: outcome.errorMessage,
        });
        this.aiUtilService.sendSSE(response, 'done', {
          message: failureMessage,
          succeeded: context.priorResults.length,
          total: steps.length,
        });
        response.end();
        return;
      }

      this.aiUtilService.sendSSE(response, 'done', { succeeded: context.priorResults.length, total: steps.length });
      response.end();
    } catch (error) {
      this.logger.error(`[approvePrd] conversationId=${conversationId} failed: ${error?.message}`, error?.stack);
      this.aiUtilService.sendSSE(response, 'error', { message: error?.message || 'Failed to build the plan' });
      response.end();
    }
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
    organizationId: string
  ): Promise<Step[]> {
    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-plan',
      {
        system: STEP_PLAN_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prd }],
        tools: { proposeStepPlan: proposeStepPlanTool },
        toolChoice: { type: 'tool', toolName: 'proposeStepPlan' },
      },
      organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'proposeStepPlan') {
      throw new Error('The assistant did not propose a build plan');
    }

    const { steps: proposedSteps } = call.args as { steps: Array<{ type: StepType; description: string }> };
    if (!proposedSteps?.length) {
      throw new Error('The assistant proposed an empty build plan');
    }

    const persisted: Step[] = [];
    for (let index = 0; index < proposedSteps.length; index++) {
      const step = await this.stepRepository.createOne({
        conversationId,
        messageId,
        order: index,
        type: proposedSteps[index].type,
        description: proposedSteps[index].description,
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
  ): Promise<{ success: boolean; artifact?: Artifact; errorMessage?: string }> {
    if (!this.SUPPORTED_STEP_TYPES.includes(step.type)) {
      const errorMessage = `Unsupported step type "${step.type}" — not yet implemented`;
      await this.stepRepository.updateOne(step.id, { status: 'failed', errorMessage });
      return { success: false, errorMessage };
    }

    let lastError: string;
    for (let attempt = 1; attempt <= this.MAX_STEP_ATTEMPTS; attempt++) {
      try {
        const { content, identifier, props } = await this.executeStep(step, context, lastError);

        const artifact = await this.artifactRepository.createOne({
          conversationId: step.conversationId,
          messageId: step.messageId,
          content,
          identifier,
        });
        await this.stepRepository.updateOne(step.id, {
          status: 'succeeded',
          props,
          attempts: attempt,
          artifactId: artifact.id,
        });
        return { success: true, artifact };
      } catch (error) {
        lastError = error?.message || 'Step execution failed';
        this.logger.warn(`[approvePrd] step=${step.id} type=${step.type} attempt=${attempt} failed: ${lastError}`);
        await this.stepRepository.updateOne(step.id, { attempts: attempt, errorMessage: lastError });
      }
    }

    await this.stepRepository.updateOne(step.id, { status: 'failed', errorMessage: lastError });
    return { success: false, errorMessage: lastError };
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

  private async executeCreateTableStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
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

    const args = call.args as {
      table_name: string;
      columns: Array<{
        column_name: string;
        data_type: string;
        is_primary_key: boolean;
        is_not_null: boolean;
        is_unique: boolean;
      }>;
    };

    const tableParams = {
      table_name: args.table_name,
      columns: args.columns.map((column) => ({
        column_name: column.column_name,
        data_type: column.data_type,
        constraints_type: {
          is_primary_key: column.is_primary_key,
          is_not_null: column.is_not_null,
          is_unique: column.is_unique,
        },
      })),
    };

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
    }

    const created = await this.agentsService.CreateComponent(context.appVersionId, context.organizationId, type, props);

    return { content: created, identifier: created.id, props: { type, ...props } };
  }

  private async executeQueryStep(
    step: Step,
    context: StepExecutionContext,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-create-query',
      {
        system: CREATE_QUERY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.buildStepContextLines(step, context, previousError) }],
        tools: { createQuery: createQueryTool },
        toolChoice: { type: 'tool', toolName: 'createQuery' },
      },
      context.organizationId
    );

    const call = result?.toolCalls?.[0];
    if (!call || call.toolName !== 'createQuery') {
      throw new Error('The assistant did not produce a query definition');
    }

    const args = call.args as { name: string; table_id: string };
    const props = {
      name: args.name,
      options: { operation: 'list_rows', table_id: args.table_id, list_rows: { limit: 100 } },
    };

    const created = await this.agentsService.CreateQuery(context.appVersionId, context.organizationId, props);

    return { content: created, identifier: created.name, props };
  }

  /**
   * Shared PRD-conversation message shape both `sendUserMessage` and `regenerateAiMessage`
   * feed to the LLM: the system prompt, `priorMessages` mapped to role/content, and an
   * optional trailing user turn (sendUserMessage's new message — regenerateAiMessage has
   * none, since the user turn it's replying to is already the last entry in priorMessages).
   */
  private buildPrdMessages(priorMessages: AiConversationMessage[], trailingUserContent?: string) {
    return [
      { role: 'system', content: PRD_SYSTEM_PROMPT },
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
    organizationId: string
  ): Promise<any> {
    const { conversationId, content, references } = body ?? ({} as typeof body);

    if (!conversationId || !content) {
      throw new BadRequestException('conversationId and content are required');
    }

    // Generate-only, the mirror of sendUserDocsMessage being Learn-only: this path answers
    // with a PRD, and a PRD in a Learn conversation could never be approved (approvePrd
    // refuses one), so it would be a proposal with no way to act on it.
    await this.loadConversationOfType(conversationId, 'generate');

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

    const messages = this.buildPrdMessages(priorMessages, content);

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
  private buildLearnMessages(inventory: string, priorMessages: AiConversationMessage[], trailingUserContent?: string) {
    return [
      { role: 'system', content: LEARN_SYSTEM_PROMPT },
      { role: 'system', content: `App inventory (current, assembled just now):\n\n${inventory}` },
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
    organizationId: string
  ): Promise<any> {
    const { conversationId, content, references } = body ?? ({} as typeof body);

    if (!conversationId || !content) {
      throw new BadRequestException('conversationId and content are required');
    }

    const conversation = await this.loadConversationOfType(conversationId, 'learn');

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
      const messages = this.buildLearnMessages(inventory, priorMessages, content);

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

    const conversation = await this.loadConversationOfType(conversationId, 'learn');
    if (conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

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
   * Not a streaming endpoint: there's no LLM call on this path, just DB/App-state undos.
   */
  async rewindStep(conversationId: string, stepId: string, organizationId: string): Promise<any> {
    if (!conversationId || !stepId) {
      throw new BadRequestException('conversationId and stepId are required');
    }

    const conversation = await this.loadConversationOfType(conversationId, 'generate');

    const targetStep = await this.stepRepository.findById(stepId);
    if (!targetStep || targetStep.conversationId !== conversationId) {
      throw new NotFoundException('Step not found in this conversation');
    }
    if (targetStep.status !== 'succeeded') {
      throw new BadRequestException('Can only rewind to a completed step');
    }

    const appVersionId = await this.resolveAppVersionId(conversation.appId);
    const stepsAfter = await this.stepRepository.findAfterOrder(conversationId, targetStep.messageId, targetStep.order);

    for (const step of [...stepsAfter].reverse()) {
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

    return { rewoundTo: targetStep.id, undone: stepsAfter.map((step) => step.id) };
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
  async regenerateAiMessage(parentMessageId: string, organizationId: string): Promise<any> {
    if (!parentMessageId) {
      throw new BadRequestException('parentMessageId is required');
    }

    const parentMessage = await this.aiConversationMessageRepository.findMessageById(parentMessageId);
    if (!parentMessage) {
      throw new NotFoundException('Message not found');
    }

    const conversationId = parentMessage.aiConversationId;
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
    const conversation = await this.aiConversationRepository.findById(conversationId);
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
}
