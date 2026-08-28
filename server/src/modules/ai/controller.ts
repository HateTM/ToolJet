import { Controller, Get, Post, Body, Param, Res, Query } from '@nestjs/common';
import { User } from '@modules/app/decorators/user.decorator';
import { UserPermissionsDecorator } from '@modules/app/decorators/user-permission.decorator';
import { UserPermissions } from '@modules/ability/types';
import { Response } from 'express';
import { IAiController } from './interfaces/IController';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { FEATURE_KEY } from './constants';
import { AiService } from './service';

@Controller('ai')
export class AiController implements IAiController {
  constructor(private readonly aiService: AiService) {}

  @InitFeature(FEATURE_KEY.FETCH_ZERO_STATE)
  @Get('/zero-state')
  async fetchZeroStateConfig(@User() user) {
    return await this.aiService.fetchZeroStateConfig(user.firstName);
  }

  @InitFeature(FEATURE_KEY.SEND_USER_MESSAGE)
  @Post('conversation/message')
  async sendUserMessage(@User() user, @Body() body, @Res() response: Response) {
    return await this.aiService.sendUserMessage(body, response, user.id, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.SEND_DOCS_MESSAGE)
  @Post('conversation/docs-message')
  async sendUserDocsMessage(@User() user, @Body() body, @Res() response: Response) {
    return await this.aiService.sendUserDocsMessage(body, response, user.id, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.PROMOTE_CONVERSATION)
  @Post('conversation/promote')
  async promoteConversation(@User() user, @Body() body) {
    const { conversationId, messageId } = body ?? {};
    return await this.aiService.promoteConversation(conversationId, messageId, user.id);
  }

  @InitFeature(FEATURE_KEY.APPROVE_PRD)
  @Post('conversation/approve-prd')
  async approvePrd(
    @User() user,
    @UserPermissionsDecorator() userPermissions: UserPermissions,
    @Body() body,
    @Res() response: Response
  ) {
    const { conversationId, prd, dataSourceId } = body ?? {};
    return await this.aiService.approvePrd(conversationId, prd, user, userPermissions, response, dataSourceId);
  }

  @InitFeature(FEATURE_KEY.REWIND_STEP)
  @Post('conversation/rewind-step')
  async rewindStep(@User() user, @Body() body) {
    const { conversationId, stepId } = body ?? {};
    return await this.aiService.rewindStep(conversationId, stepId, user.id, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.REGENERATE_MESSAGE)
  @Post('conversation/regenerate-message')
  async regenerateAiMessage(@User() user, @Body() body) {
    const { parentMessageId } = body ?? {};
    return await this.aiService.regenerateAiMessage(parentMessageId, user.id, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.VOTE_MESSAGE)
  @Post('conversation/vote-message')
  async voteAiMessage(@User() user, @Body() body) {
    const { messageId, voteType } = body ?? {};
    return await this.aiService.voteAiMessage(messageId, voteType, user.id);
  }

  // Not a conversation endpoint (ADR-0014): one failing property expression in, one
  // Suggestion out, nothing persisted — so it takes no conversationId and isn't streamed.
  @InitFeature(FEATURE_KEY.FIX_WITH_AI)
  @Post('/fix-with-ai')
  async fixWithAi(@User() user, @Body() body) {
    return await this.aiService.fixWithAi(body, user.organizationId);
  }

  // Also not a conversation endpoint (ADR-0016): one prompt plus the editor's context in,
  // one Completion out, nothing persisted and nothing streamed.
  @InitFeature(FEATURE_KEY.COPILOT)
  @Post('/copilot')
  async copilot(@User() user, @Body() body) {
    return await this.aiService.copilot(body, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.GET_CREDITS_BALANCE)
  @Get('/get-credits-balance')
  async getCreditsBalance(@User() user) {
    return await this.aiService.getCreditsBalance(user.organizationId);
  }

  @InitFeature(FEATURE_KEY.LIST_CONVERSATIONS)
  @Get('conversations')
  async listConversations(
    @User() user,
    @Query('appId') appId: string,
    @Query('conversationType') conversationType: string
  ) {
    return await this.aiService.listConversations(appId, user.id, conversationType);
  }

  @InitFeature(FEATURE_KEY.CREATE_CONVERSATION)
  @Post('conversation')
  async createConversation(@User() user, @Body() body) {
    const { appId, conversationType, currentConversationId, handoff } = body ?? {};
    return await this.aiService.createConversation(
      user.id,
      appId,
      conversationType,
      user.organizationId,
      currentConversationId,
      handoff
    );
  }

  @InitFeature(FEATURE_KEY.GET_CONVERSATION)
  @Get('conversation/:conversationId')
  async getConversationById(@User() user, @Param('conversationId') conversationId: string) {
    return await this.aiService.getConversationById(conversationId, user.id);
  }
}
