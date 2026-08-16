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
import { Step, StepType } from '@entities/step.entity';
import { Artifact } from '@entities/artifact.entity';

// Grounds the assistant in the Generate-conversation contract (see CONTEXT.md's
// "PRD" entry and ADR-0001): a Generate conversation only ever proposes a PRD in
// chat — it must never claim to have changed the App, since nothing is built
// until the user approves it (a later ticket). v1 target types per ADR-0002.
const PRD_SYSTEM_PROMPT = `You are the AI Builder assistant for ToolJet, a low-code app platform.

Your job in this conversation is to help the user turn their app idea into a clear Product Requirements Document (PRD): a structured description of the app to build — its pages, and for each page the components (Page, Table, Form, Button, Text, TextInput, Container) and any data queries it needs.

Ask clarifying questions if the request is ambiguous or underspecified. Once you have enough detail, respond with a structured PRD covering the app's purpose, its pages, and the components/queries each page needs. The user can keep refining the PRD by chatting further — nothing is built until they explicitly approve it.`;

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

@Injectable()
export class AiService implements IAiService {
  private readonly logger = new Logger(AiService.name);

  private readonly SUPPORTED_STEP_TYPES: StepType[] = ['CreateTable'];
  private readonly MAX_STEP_ATTEMPTS = 3; // 1 initial attempt + 2 retries, per ticket acceptance criteria

  constructor(
    private readonly aiUtilService: AiUtilService,
    private readonly aiConversationRepository: AiConversationRepository,
    private readonly aiConversationMessageRepository: AiConversationMessageRepository,
    private readonly agentsService: AgentsService,
    private readonly artifactRepository: ArtifactRepository,
    private readonly stepRepository: StepRepository
  ) {}

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

  async voteAiMessage(messageId, voteType, userId): Promise<any> {
    throw new Error('Method not implemented.');
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

    const conversation = await this.aiConversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const conversationMessages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);
    const prdMessage = [...conversationMessages].reverse().find((message) => message.messageType === 'ai');
    if (!prdMessage) {
      throw new BadRequestException('No PRD message found to approve');
    }

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');

    try {
      const steps = await this.generateStepPlan(prd, conversationId, prdMessage.id, organizationId);

      this.aiUtilService.sendSSE(response, 'plan', {
        steps: steps.map((step) => ({ id: step.id, type: step.type, description: step.description })),
      });

      const succeededArtifacts: Artifact[] = [];

      for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        await this.stepRepository.updateOne(step.id, { status: 'running' });
        this.aiUtilService.sendSSE(response, 'step-progress', {
          step: index + 1,
          of: steps.length,
          description: step.description,
        });

        const outcome = await this.executeStepWithRetry(step, prd, succeededArtifacts, organizationId);

        if (outcome.success) {
          succeededArtifacts.push(outcome.artifact);
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
          succeeded: succeededArtifacts.length,
          total: steps.length,
        });
        response.end();
        return;
      }

      this.aiUtilService.sendSSE(response, 'done', { succeeded: succeededArtifacts.length, total: steps.length });
      response.end();
    } catch (error) {
      this.logger.error(`[approvePrd] conversationId=${conversationId} failed: ${error?.message}`, error?.stack);
      this.aiUtilService.sendSSE(response, 'error', { message: error?.message || 'Failed to build the plan' });
      response.end();
    }
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
    prd: string,
    priorArtifacts: Artifact[],
    organizationId: string
  ): Promise<{ success: boolean; artifact?: Artifact; errorMessage?: string }> {
    if (!this.SUPPORTED_STEP_TYPES.includes(step.type)) {
      const errorMessage = `Unsupported step type "${step.type}" — not yet implemented`;
      await this.stepRepository.updateOne(step.id, { status: 'failed', errorMessage });
      return { success: false, errorMessage };
    }

    let lastError: string;
    for (let attempt = 1; attempt <= this.MAX_STEP_ATTEMPTS; attempt++) {
      try {
        const { content, identifier, props } = await this.executeStep(
          step,
          prd,
          priorArtifacts,
          organizationId,
          lastError
        );

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
    prd: string,
    priorArtifacts: Artifact[],
    organizationId: string,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    switch (step.type) {
      case 'CreateTable':
        return this.executeCreateTableStep(step, prd, priorArtifacts, organizationId, previousError);
      default:
        throw new Error(`Unsupported step type "${step.type}"`);
    }
  }

  private async executeCreateTableStep(
    step: Step,
    prd: string,
    priorArtifacts: Artifact[],
    organizationId: string,
    previousError?: string
  ): Promise<{ content: any; identifier: string; props: any }> {
    const contextLines = [`PRD:\n${prd}`, `Step to build: ${step.description}`];
    if (priorArtifacts.length) {
      contextLines.push(
        `Already created in this plan: ${priorArtifacts.map((artifact) => artifact.identifier).join(', ')} — avoid name collisions with these.`
      );
    }
    if (previousError) {
      contextLines.push(`The previous attempt failed with: "${previousError}". Fix the issue and try again.`);
    }

    const result = await this.aiUtilService.AIGatewayGenerate(
      'openai',
      'approve-prd-create-table',
      {
        system: CREATE_TABLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: contextLines.join('\n\n') }],
        tools: { createTable: createTableTool },
        toolChoice: { type: 'tool', toolName: 'createTable' },
      },
      organizationId
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

    const created = await this.agentsService.CreateTable(organizationId, tableParams);

    return { content: created, identifier: created.table_name, props: tableParams };
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

    const conversation = await this.aiConversationRepository.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

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

    const messages = [
      { role: 'system', content: PRD_SYSTEM_PROMPT },
      ...priorMessages.map((message) => ({
        role: message.messageType === 'user' ? 'user' : 'assistant',
        content: message.content,
      })),
      { role: 'user', content },
    ];

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

  async sendUserDocsMessage(body, response, organizationId) {
    throw new Error('Method not implemented.');
  }

  async regenerateAiMessage(parentMessageId, organizationId): Promise<any> {
    throw new Error('Method not implemented.');
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

  async listConversations(appId: string, userId: string, conversationType: string): Promise<any> {
    return this.aiUtilService.getConversationsList(appId, userId, conversationType);
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
    return this.aiUtilService.createNewConversation(userId, appId, conversationType, currentConversationId, handoff);
  }

  async getConversationById(conversationId: string, userId: string): Promise<any> {
    return this.aiUtilService.getConversationById(conversationId, userId);
  }

  async getThreadTokenUsage(conversationId: string, user: any): Promise<any> {
    throw new Error('Method not implemented.');
  }
}
