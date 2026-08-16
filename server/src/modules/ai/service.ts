import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { IAiService } from './interfaces/IService';
import { AiUtilService } from './util.service';
import { AiConversationRepository } from './repositories/ai-conversation.repository';
import { AiConversationMessageRepository } from './repositories/ai-conversation-message.repository';

// Grounds the assistant in the Generate-conversation contract (see CONTEXT.md's
// "PRD" entry and ADR-0001): a Generate conversation only ever proposes a PRD in
// chat — it must never claim to have changed the App, since nothing is built
// until the user approves it (a later ticket). v1 target types per ADR-0002.
const PRD_SYSTEM_PROMPT = `You are the AI Builder assistant for ToolJet, a low-code app platform.

Your job in this conversation is to help the user turn their app idea into a clear Product Requirements Document (PRD): a structured description of the app to build — its pages, and for each page the components (Page, Table, Form, Button, Text, TextInput, Container) and any data queries it needs.

Ask clarifying questions if the request is ambiguous or underspecified. Once you have enough detail, respond with a structured PRD covering the app's purpose, its pages, and the components/queries each page needs. The user can keep refining the PRD by chatting further — nothing is built until they explicitly approve it.`;

@Injectable()
export class AiService implements IAiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly aiUtilService: AiUtilService,
    private readonly aiConversationRepository: AiConversationRepository,
    private readonly aiConversationMessageRepository: AiConversationMessageRepository
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

  async approvePrd(conversationId, prd, organizationId, response) {
    throw new Error('Method not implemented.');
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
