import { Logger } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { IAiUtilService } from './interfaces/IUtilService';

const SUPPORTED_AI_PROVIDERS = ['openai'];

export class AiUtilService implements IAiUtilService {
  private readonly logger = new Logger(AiUtilService.name);

  constructor() {}

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

  public sendSSE(res: any, type: string, data: any) {
    throw new Error('Method not implemented.');
  }

  async getConversation(appId: string, userId: string, conversationType: string): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async createNewConversation(userId, appId, conversationType): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async getConversationsList(appId: string, userId: string, conversationType: string): Promise<any[]> {
    throw new Error('Method not implemented.');
  }

  async getConversationById(conversationId: string, userId: string): Promise<any> {
    throw new Error('Method not implemented.');
  }
}
