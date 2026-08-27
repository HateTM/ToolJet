import { Response } from 'express';
import { User } from '@entities/user.entity';

export interface IAiController {
  fetchZeroStateConfig(user: User): Promise<any>;

  sendUserMessage(user: User, body: any, response: Response): Promise<any>;

  sendUserDocsMessage(user: User, body: any, response: Response): Promise<any>;

  promoteConversation(user: User, body: any): Promise<any>;

  approvePrd(user: User, conversationId: string, body: any, response: Response): Promise<any>;

  rewindStep(user: User, body: any): Promise<any>;

  regenerateAiMessage(user: User, body: any): Promise<any>;

  voteAiMessage(user: User, body: any): Promise<any>;

  getCreditsBalance(user: User): Promise<any>;

  listConversations(user: User, appId: string, conversationType: string): Promise<any>;

  createConversation(user: User, body: any): Promise<any>;

  getConversationById(user: User, conversationId: string): Promise<any>;
}
