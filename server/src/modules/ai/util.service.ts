import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, generateText } from 'ai';
import { IAiUtilService } from './interfaces/IUtilService';
import { AiConversationRepository } from './repositories/ai-conversation.repository';
import { AiConversationMessageRepository } from './repositories/ai-conversation-message.repository';
import { AiConversation } from '@entities/ai_conversation.entity';

const SUPPORTED_AI_PROVIDERS = ['openai'];

// Mirrors AiConversation.conversationType — the repositories are typed against this
// union, but IAiUtilService (and controllers upstream) pass conversationType as a
// plain string, so it's cast at the boundary here rather than repeated per call site.
type ConversationType = 'generate' | 'learn';

// Without @Injectable() tsc emits no design:paramtypes for this class, so Nest
// instantiates it with undefined repositories (findAllByAppAndUser TypeError).
@Injectable()
export class AiUtilService implements IAiUtilService {
  private readonly logger = new Logger(AiUtilService.name);

  constructor(
    private readonly aiConversationRepository: AiConversationRepository,
    private readonly aiConversationMessageRepository: AiConversationMessageRepository
  ) {}

  public getAgentAssetPath(filename) {
    throw new Error('Method not implemented.');
  }

  public mergeSteps(componentsJson, newStepsJson) {
    throw new Error('Method not implemented.');
  }

  public AgenticMergeSteps(input) {
    throw new Error('Method not implemented.');
  }

  /**
   * The sole point where the assistant talks to the LLM (ADR-0003).
   *
   * Builds an OpenAI-compatible provider (works against any OpenAI-compatible
   * endpoint, e.g. LocalAI) from OPENAI_BASE_URL / OPENAI_API_KEY, resolves the
   * configured AI_MODEL, and passes `prompt_body` (messages, optional tools,
   * etc.) straight through to the AI SDK's `streamText`.
   *
   * Returns the `streamText` result object as-is (not consumed here) so a
   * caller can pipe `.textStream`/`.fullStream` etc. into an SSE response;
   * this function stays a clean (config, prompt) -> LLM result mapping and
   * doesn't touch Response/SSE itself.
   *
   * `operation_id` is not used for routing yet, only for log tagging, and
   * `provider` is validated (only 'openai' is supported for now) so both stay
   * forward-compatible for later multi-provider routing without being
   * silently dropped.
   */
  async AIGateway(provider: string, operation_id: string, prompt_body: any, organizationId: string): Promise<any> {
    const model = this.resolveModel(provider, operation_id, organizationId);

    return streamText({
      model,
      ...prompt_body,
    });
  }

  /**
   * Non-streaming counterpart to `AIGateway`, for callers that need a resolved
   * result (in particular tool calls) rather than a token stream — e.g. Step-plan
   * generation and per-step prop-filling at `approvePrd` (ADR-0004), which need
   * the model's structured tool-call output before they can proceed, not text
   * to forward to a chat panel.
   */
  async AIGatewayGenerate(
    provider: string,
    operation_id: string,
    prompt_body: any,
    organizationId: string
  ): Promise<any> {
    const model = this.resolveModel(provider, operation_id, organizationId);

    return generateText({
      model,
      ...prompt_body,
    });
  }

  private resolveModel(provider: string, operation_id: string, organizationId: string) {
    if (!SUPPORTED_AI_PROVIDERS.includes(provider)) {
      throw new Error(`AIGateway: unsupported provider "${provider}"`);
    }

    this.logger.debug(`[AIGateway] provider=${provider} operation_id=${operation_id} organizationId=${organizationId}`);

    const openaiProvider = createOpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    });

    return openaiProvider(process.env.AI_MODEL);
  }

  async createComponentfromSteps(steps, componentDatapath?: string): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async getComponentsfromsteps(steps) {
    throw new Error('Method not implemented.');
  }

  async createQueryfromSteps(steps) {
    throw new Error('Method not implemented.');
  }

  async getQueriesfromsteps(steps) {
    throw new Error('Method not implemented.');
  }

  async convertToSteps(jsonData: any): Promise<any> {
    throw new Error('Method not implemented.');
  }
  public getColorScheme(prd) {
    throw new Error('Method not implemented.');
  }

  /**
   * Writes a single Server-Sent Event to `res` in standard wire format:
   *
   *   event: <type>
   *   data: <JSON.stringify(data)>
   *   (blank line)
   *
   * Caller is responsible for setting the SSE response headers before the
   * first call, and for ending the response once done.
   */
  public sendSSE(res: any, type: string, data: any) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  async getConversation(appId: string, userId: string, conversationType: string): Promise<AiConversation> {
    return this.aiConversationRepository.findByAppAndUser(appId, userId, conversationType as ConversationType);
  }

  /**
   * Creates (or reactivates) the conversation a user's message thread should
   * continue on:
   *  - `currentConversationId` set: reactivate that specific conversation
   *    (deactivating any other active one for the same app/user/type).
   *  - otherwise: start a brand new conversation, deactivating whatever was
   *    previously active (see AiConversationRepository.createNewConversation).
   *
   * `handoff` marks a Generate conversation that was started by promoting a Learn one
   * (ADR-0012) — Promote never converts the Learn thread, it always lands here creating a new
   * conversation, and this is what distinguishes such a thread from one started from scratch.
   */
  async createNewConversation(
    userId: string,
    appId: string,
    conversationType: string,
    currentConversationId?: string,
    handoff?: boolean
  ): Promise<AiConversation> {
    const type = conversationType as ConversationType;

    if (currentConversationId) {
      const existing = await this.aiConversationRepository.findById(currentConversationId);
      // Reactivation flips `active` on an existing conversation, so it must belong to the caller
      // — otherwise knowing a conversation UUID would let a user hijack someone else's active
      // thread. Folded into the same NotFoundException as the existence check (no enumeration).
      if (!existing || existing.userId !== userId) {
        throw new NotFoundException('Conversation not found');
      }
      // A conversation's type is fixed for its whole lifetime (CONTEXT.md; ADR-0012 is
      // built on it). Reactivating is the only path that touches an existing conversation
      // from the outside, so it's where a caller could otherwise quietly re-label a Learn
      // thread as Generate by reactivating it under the wrong type.
      if (existing.conversationType !== type) {
        throw new BadRequestException(
          `Conversation is a "${existing.conversationType}" conversation and cannot be continued as "${type}"`
        );
      }
      await this.aiConversationRepository.setActive(currentConversationId, appId, userId, type);
      // Re-read rather than returning `existing`: setActive is what flips `active` to true,
      // so the row fetched before it still says otherwise.
      return this.aiConversationRepository.findById(currentConversationId);
    }

    const conversation = await this.aiConversationRepository.createNewConversation(userId, appId, type);

    if (handoff) {
      const metadata = { ...(conversation.metadata || {}), handoff: true };
      await this.aiConversationRepository.updateOne(conversation.id, { metadata });
      conversation.metadata = metadata;
    }

    return conversation;
  }

  async getConversationsList(appId: string, userId: string, conversationType: string): Promise<AiConversation[]> {
    return this.aiConversationRepository.findAllByAppAndUser(appId, userId, conversationType as ConversationType);
  }

  async getConversationById(conversationId: string, userId: string): Promise<any> {
    const conversation = await this.aiConversationRepository.findById(conversationId);
    if (!conversation || conversation.userId !== userId) {
      throw new NotFoundException('Conversation not found');
    }

    const messages = await this.aiConversationMessageRepository.findLatestByConversationId(conversationId);

    return { ...conversation, messages };
  }
}
