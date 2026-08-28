import { Response } from 'express';
import { AiConversationMessage } from '@entities/ai_conversation_message.entity';
import { User } from '@entities/user.entity';
import { UserPermissions } from '@modules/ability/types';
import { Completion, CopilotContext, ErrorContext, Suggestion } from '../types';

export interface IAiService {
  fetchZeroStateConfig(firstName: string): Promise<
    | {
        user: {
          name: string;
          greeting: string;
          description: string;
        };
        suggestions: Array<{
          icon: string;
          label: string;
          action: string;
        }>;
      }
    | any
  >;

  sendUserMessage(
    body: { conversationId: string; content: string; references?: any },
    response: Response,
    organizationId: string
  ): Promise<any>;

  sendUserDocsMessage(
    body: { conversationId: string; content: string },
    response: Response,
    organizationId: string
  ): Promise<any>;

  promoteConversation(conversationId: string, messageId: string, userId: string): Promise<any>;

  approvePrd(
    conversationId: string,
    prd: any,
    user: User,
    userPermissions: UserPermissions,
    response: Response
  ): Promise<any>;

  rewindStep(conversationId: string, stepId: string, organizationId: string): Promise<any>;

  regenerateAiMessage(parentMessageId: string, organizationId: string): Promise<AiConversationMessage | any>;

  voteAiMessage(messageId: string, voteType: string, userId: string): Promise<any>;

  // One-shot `Fix with AI` request (ADR-0014): takes an `Error context` for a single failing
  // component property, returns one `Suggestion`. Touches no conversation.
  fixWithAi(body: ErrorContext, organizationId: string): Promise<Suggestion>;

  // One-shot `Copilot` request (ADR-0016): takes a `Copilot context` for one query editor,
  // returns one `Completion`. Touches no conversation.
  copilot(body: CopilotContext, organizationId: string): Promise<Completion>;

  getCreditsBalance(organizationId: string): Promise<
    | {
        aiFeaturesEnabled: boolean;
        error?: string;
      }
    | any
  >;

  listConversations(appId: string, userId: string, conversationType: string): Promise<any>;

  createConversation(
    userId: string,
    appId: string,
    conversationType: string,
    organizationId: string,
    currentConversationId?: string,
    handoff?: boolean
  ): Promise<any>;

  getConversationById(conversationId: string, userId: string): Promise<any>;
}
