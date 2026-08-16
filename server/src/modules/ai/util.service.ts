import { Logger, NotFoundException } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { IAiUtilService } from './interfaces/IUtilService';
import { AiConversationRepository } from './repositories/ai-conversation.repository';
import { AiConversationMessageRepository } from './repositories/ai-conversation-message.repository';
import { AiConversation } from '@entities/ai_conversation.entity';

const SUPPORTED_AI_PROVIDERS = ['openai'];

// Mirrors AiConversation.conversationType — the repositories are typed against this
// union, but IAiUtilService (and controllers upstream) pass conversationType as a
// plain string, so it's cast at the boundary here rather than repeated per call site.
type ConversationType = 'generate' | 'learn';

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
    if (!SUPPORTED_AI_PROVIDERS.includes(provider)) {
      throw new Error(`AIGateway: unsupported provider "${provider}"`);
    }

    this.logger.debug(`[AIGateway] provider=${provider} operation_id=${operation_id} organizationId=${organizationId}`);

    const openaiProvider = createOpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    });

    const model = openaiProvider(process.env.AI_MODEL);

    return streamText({
      model,
      ...prompt_body,
    });
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
   * `handoff` (e.g. moving from a "learn" thread into "generate") is recorded
   * on the conversation's metadata for later tickets to key off of.
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
      await this.aiConversationRepository.setActive(currentConversationId, appId, userId, type);
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
