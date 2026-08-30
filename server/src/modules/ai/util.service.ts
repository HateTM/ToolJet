import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { streamText, generateText } from 'ai';
import { IAiUtilService } from './interfaces/IUtilService';
import { AiConversationRepository } from './repositories/ai-conversation.repository';
import { AiConversationMessageRepository } from './repositories/ai-conversation-message.repository';
import { AiConversation } from '@entities/ai_conversation.entity';
import { AiKeySettingsService } from './services/ai-key-settings.service';
import { EffectiveAiConfig } from './interfaces/IAiKeySettingsService';
import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_TOKEN_ESTIMATION_RATIO,
  LlmProvider,
  MESSAGE_TOKEN_OVERHEAD,
  PROVIDER_CONTEXT_WINDOWS,
  VALID_LLM_PROVIDERS,
} from './constants/llm';

// Ticket #59: every provider the factory can build is now a valid routing input;
// the org BYOK config decides which one actually serves the request.
const SUPPORTED_AI_PROVIDERS: string[] = VALID_LLM_PROVIDERS;

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
    private readonly aiConversationMessageRepository: AiConversationMessageRepository,
    private readonly aiKeySettingsService: AiKeySettingsService
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
    const model = await this.resolveModel(provider, operation_id, organizationId);

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
    if (!SUPPORTED_AI_PROVIDERS.includes(provider)) {
      throw new Error(`AIGateway: unsupported provider "${provider}"`);
    }

    return generateText({
      model: await this.resolveModel(provider, operation_id, organizationId),
      ...prompt_body,
    });
  }

  /**
   * Ticket #59: provider factory. Builds the AI SDK language model for the org's
   * configured provider. OpenAI-compatible providers (openai/grok/openrouter)
   * share `createOpenAI` with a per-provider base URL; `baseURL` from the org
   * config is honored for plain `openai` so self-hosted gateways keep working.
   */
  private buildProvider(config: EffectiveAiConfig) {
    switch (config.provider) {
      case 'anthropic':
        return createAnthropic({ apiKey: config.apiKey })(config.model);
      case 'gemini':
        return createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model);
      case 'grok':
        return createOpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: config.apiKey })(config.model);
      case 'openrouter':
        return createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: config.apiKey })(config.model);
      case 'openai':
        return createOpenAI({ baseURL: config.baseURL, apiKey: config.apiKey })(config.model);
      default:
        throw new Error(`AIGateway: unsupported org provider "${config.provider}"`);
    }
  }

  /**
   * Resolves the language model for an AIGateway/AIGatewayGenerate call.
   *
   * Priority (ticket #59): the organization's BYOK configuration (provider,
   * model, decrypted key — re-read per request, so changes apply without a
   * server restart) falls back to the env-configured OpenAI-compatible gateway.
   * The `provider` argument remains the request-level default, used for
   * validation and env-fallback tagging.
   */
  private async resolveModel(provider: string, operation_id: string, organizationId: string) {
    this.logger.debug(`[AIGateway] provider=${provider} operation_id=${operation_id} organizationId=${organizationId}`);

    const orgConfig = await this.aiKeySettingsService.getEffectiveOrgConfig(organizationId);
    if (orgConfig) {
      this.logger.debug(
        `[AIGateway] using org config: provider=${orgConfig.provider} model=${orgConfig.model} organizationId=${organizationId}`
      );
      return this.buildProvider(orgConfig);
    }

    const openaiProvider = createOpenAI({
      baseURL: process.env.OPENAI_BASE_URL,
      apiKey: process.env.OPENAI_API_KEY,
    });

    return openaiProvider(process.env.AI_MODEL);
  }

  /**
   * Context-window fitting against the provider the request will actually use:
   * the org's configured provider/model window when a BYOK config is active,
   * otherwise the previous env-default ('openai') behavior.
   */
  async fitMessagesToContextWindowForOrg(
    organizationId: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<{
    messages: Array<{ role: string; content: string }>;
    truncated: Array<{
      role: string;
      originalTokens: number;
      keptTokens: number;
      droppedTokens: number;
      reason: 'content-truncated' | 'message-dropped';
    }>;
  }> {
    const orgConfig = await this.aiKeySettingsService.getEffectiveOrgConfig(organizationId);
    if (orgConfig) {
      return this.fitMessagesToContextWindow(messages, orgConfig.provider, orgConfig.contextWindow);
    }
    return this.fitMessagesToContextWindow(messages, 'openai');
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
   * Guards against writing to a response that has already been closed, and
   * flushes the underlying stream so proxies do not buffer the event.
   * Caller is responsible for setting the SSE response headers before the
   * first call, and for ending the response once done.
   */
  public sendSSE(res: any, type: string, data: any) {
    if (!res || res.writableEnded || res.destroyed || res.finished) {
      return;
    }

    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);

    if (typeof res.flush === 'function') {
      res.flush();
    }
  }

  /**
   * Starts a recurring heartbeat on an active SSE response. Sends an event of
   * type `heartbeat` with `{ timestamp }` every `intervalMs` milliseconds.
   *
   * The interval is automatically cleared when the response emits `close` or
   * `finish`, so disconnecting/aborting clients never leave a dangling timer
   * and never trigger writes after the response has ended.
   */
  public startHeartbeat(res: any, intervalMs = 5000): ReturnType<typeof setInterval> {
    const interval = setInterval(() => {
      this.sendSSE(res, 'heartbeat', { timestamp: Date.now() });
    }, intervalMs);

    const cleanup = () => clearInterval(interval);
    res.once('close', cleanup);
    res.once('finish', cleanup);

    return interval;
  }

  /**
   * Initializes an SSE response: sets the required headers, flushes them to
   * the client immediately, and writes a comment line so proxies see bytes on
   * the wire and do not buffer the stream.
   */
  public initSSE(res: any) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.flushHeaders();
    res.write(':heartbeat\n\n');

    if (typeof res.flush === 'function') {
      res.flush();
    }
  }

  async getConversation(appId: string, userId: string, conversationType: string): Promise<AiConversation> {
    return this.aiConversationRepository.findByAppAndUser(appId, userId, conversationType as ConversationType);
  }

  /**
   * Estimates the number of tokens in a text string using a simple bytes-per-token
   * heuristic. AI Builder CE does not ship a real tokenizer, so this approximation is
   * intentionally conservative: it divides the UTF-8 byte length by a configurable
   * ratio (default 4) and rounds up. It is good enough for budget-based truncation
   * and avoids pulling in heavy native tokenization dependencies.
   *
   * The ratio can be tuned with `AI_TOKEN_ESTIMATION_RATIO` (a positive number).
   */
  estimateTokenCount(content: string): number {
    if (!content) return 0;
    const ratio = this.getEstimationRatio();
    return Math.ceil(Buffer.byteLength(content, 'utf8') / ratio);
  }

  private getEstimationRatio(): number {
    const parsed = parseFloat(process.env.AI_TOKEN_ESTIMATION_RATIO || '');
    return parsed > 0 ? parsed : DEFAULT_TOKEN_ESTIMATION_RATIO;
  }

  private messageTokenCost(content: string): number {
    return this.estimateTokenCount(content) + MESSAGE_TOKEN_OVERHEAD;
  }

  /**
   * Resolves the effective context-window size (in tokens) for a provider.
   *
   * Precedence:
   * 1. Explicit `configuredWindow` argument (e.g., per-model setting in a later ticket).
   * 2. `AI_CONTEXT_WINDOW` environment variable.
   * 3. Hard-coded default for the provider.
   *
   * Explicit and env values are floored at 1 so a zero/negative value cannot accidentally make
   * the whole window 0 (which would drop every message); otherwise the value is honored as-is so
   * a small configured window can exercise the truncation path in tests.
   */
  getContextWindow(provider?: string, configuredWindow?: number): number {
    if (typeof configuredWindow === 'number' && !Number.isNaN(configuredWindow)) {
      return Math.max(1, configuredWindow);
    }

    const envWindow = parseInt(process.env.AI_CONTEXT_WINDOW || '', 10);
    if (!Number.isNaN(envWindow)) {
      return Math.max(1, envWindow);
    }

    const normalized = (provider || '').toLowerCase();
    const validProvider = VALID_LLM_PROVIDERS.includes(normalized as LlmProvider)
      ? (normalized as LlmProvider)
      : DEFAULT_LLM_PROVIDER;

    return PROVIDER_CONTEXT_WINDOWS[validProvider] ?? PROVIDER_CONTEXT_WINDOWS[DEFAULT_LLM_PROVIDER];
  }

  /**
   * Truncates a message list so the estimated total token count fits inside the
   * configured context window for `provider`.
   *
   * Truncation follows the priority required by ticket #58:
   *   1. The first system prompt (e.g., PRD_SYSTEM_PROMPT / LEARN_SYSTEM_PROMPT).
   *   2. Other system messages — App inventory, @-mention context, and other injections.
   *   3. Conversation history, keeping the most recent messages and dropping older ones.
   *
   * When a single message does not fit in the remaining budget, its content is trimmed
   * from the end rather than dropped entirely, so the request degrades controllably and
   * never produces an unhandled context-overflow error.
   *
   * Returns the truncated messages (in original order) and an array describing what was
   * cut, so callers can log or surface the degradation.
   */
  fitMessagesToContextWindow(
    messages: Array<{ role: string; content: string }>,
    provider?: string,
    configuredWindow?: number
  ): {
    messages: Array<{ role: string; content: string }>;
    truncated: Array<{
      role: string;
      originalTokens: number;
      keptTokens: number;
      droppedTokens: number;
      reason: 'content-truncated' | 'message-dropped';
    }>;
  } {
    if (!messages?.length) {
      return { messages: [], truncated: [] };
    }

    const contextWindow = this.getContextWindow(provider, configuredWindow);
    const working = messages.map((message, idx) => ({
      ...message,
      idx,
      priority: message.role === 'system' ? (idx === 0 ? 0 : 1) : 2,
    }));
    const kept = new Array(working.length).fill(false);
    const truncated: Array<{
      role: string;
      originalTokens: number;
      keptTokens: number;
      droppedTokens: number;
      reason: 'content-truncated' | 'message-dropped';
    }> = [];

    const logTruncation = (
      role: string,
      originalTokens: number,
      keptTokens: number,
      reason: 'content-truncated' | 'message-dropped'
    ) => {
      if (originalTokens <= keptTokens && reason === 'content-truncated') return;
      truncated.push({
        role,
        originalTokens,
        keptTokens,
        droppedTokens: Math.max(0, originalTokens - keptTokens),
        reason,
      });
    };

    let remaining = contextWindow;

    // Pass 1: the primary system prompt (always the first message in AI Builder prompts).
    if (working[0]?.role === 'system') {
      const cost = this.messageTokenCost(working[0].content);
      if (cost <= remaining) {
        kept[0] = true;
        remaining -= cost;
      } else {
        const allowed = Math.max(0, remaining - MESSAGE_TOKEN_OVERHEAD);
        const trimmed = this.truncateContentToTokenBudget(working[0].content, allowed);
        const keptCost = this.messageTokenCost(trimmed);
        working[0].content = trimmed;
        kept[0] = true;
        remaining = Math.max(0, remaining - keptCost);
        logTruncation('system', cost, keptCost, 'content-truncated');
      }
    }

    // Pass 2: remaining system messages (inventory, @-mentions, etc.) in original order.
    for (let i = 1; i < working.length; i++) {
      if (working[i].role !== 'system') continue;
      const cost = this.messageTokenCost(working[i].content);

      if (remaining <= 0) {
        logTruncation(working[i].role, cost, 0, 'message-dropped');
        continue;
      }

      if (cost <= remaining) {
        kept[i] = true;
        remaining -= cost;
      } else {
        const allowed = Math.max(0, remaining - MESSAGE_TOKEN_OVERHEAD);
        const trimmed = this.truncateContentToTokenBudget(working[i].content, allowed);
        const keptCost = this.messageTokenCost(trimmed);
        working[i].content = trimmed;
        kept[i] = true;
        remaining = 0;
        logTruncation(working[i].role, cost, keptCost, 'content-truncated');
      }
    }

    // Pass 3: conversation history, newest first, so older turns are dropped first.
    for (let i = working.length - 1; i >= 0; i--) {
      if (working[i].priority !== 2) continue;
      const cost = this.messageTokenCost(working[i].content);

      if (remaining <= 0) {
        logTruncation(working[i].role, cost, 0, 'message-dropped');
        continue;
      }

      if (cost <= remaining) {
        kept[i] = true;
        remaining -= cost;
      } else {
        const allowed = Math.max(0, remaining - MESSAGE_TOKEN_OVERHEAD);
        const trimmed = this.truncateContentToTokenBudget(working[i].content, allowed);
        const keptCost = this.messageTokenCost(trimmed);
        working[i].content = trimmed;
        kept[i] = true;
        remaining = 0;
        logTruncation(working[i].role, cost, keptCost, 'content-truncated');
      }
    }

    const resultMessages = working.filter((_, idx) => kept[idx]).map(({ role, content }) => ({ role, content }));

    if (truncated.length) {
      const totalDropped = truncated.reduce((sum, entry) => sum + entry.droppedTokens, 0);
      this.logger.warn(
        `[contextWindow] prompt truncated for provider=${provider}; totalDroppedTokens=${totalDropped}, details=${JSON.stringify(
          truncated
        )}`
      );
    }

    return { messages: resultMessages, truncated };
  }

  /**
   * Trims `content` so its estimated token count is at most `maxTokens`.
   *
   * Operates on UTF-8 byte boundaries so it never produces invalid partial characters.
   * If `maxTokens` is zero or negative, returns an empty string.
   */
  private truncateContentToTokenBudget(content: string, maxTokens: number): string {
    if (maxTokens <= 0) return '';
    const ratio = this.getEstimationRatio();
    const maxBytes = Math.max(0, Math.floor(maxTokens * ratio));
    const buffer = Buffer.from(content, 'utf8');

    if (buffer.length <= maxBytes) return content;

    // Walk back from maxBytes to the last byte that is not a UTF-8 continuation byte
    // (0x80-0xBF), so the slice ends on a complete character.
    let end = maxBytes;
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
      end--;
    }

    return buffer.subarray(0, end).toString('utf8');
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
