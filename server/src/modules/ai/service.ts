import { Injectable } from '@nestjs/common';
import { IAiService } from './interfaces/IService';

@Injectable()
export class AiService implements IAiService {
  constructor() {}

  async fetchZeroStateConfig(firstName): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async voteAiMessage(messageId, voteType, userId): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async approvePrd(conversationId, prd, organizationId, response) {
    throw new Error('Method not implemented.');
  }

  async sendUserMessage(body, response, organizationId) {
    throw new Error('Method not implemented.');
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
    throw new Error('Method not implemented.');
  }

  async createConversation(
    userId: string,
    appId: string,
    conversationType: string,
    organizationId: string,
    currentConversationId?: string,
    handoff?: boolean
  ): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async getConversationById(conversationId: string, userId: string): Promise<any> {
    throw new Error('Method not implemented.');
  }

  async getThreadTokenUsage(conversationId: string, user: any): Promise<any> {
    throw new Error('Method not implemented.');
  }
}
