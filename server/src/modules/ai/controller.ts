import { Controller, Get, Post, Body, Param, Res, NotFoundException, Query } from '@nestjs/common';
import { User } from '@modules/app/decorators/user.decorator';
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
    return await this.aiService.sendUserMessage(body, response, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.SEND_DOCS_MESSAGE)
  @Post('conversation/docs-message')
  async sendUserDocsMessage(@User() user, @Body() body, @Res() response: Response) {
    throw new NotFoundException();
  }

  @InitFeature(FEATURE_KEY.APPROVE_PRD)
  @Post('conversation/approve-prd')
  async approvePrd(@User() user, @Body() body, @Res() response: Response) {
    const { conversationId, prd } = body ?? {};
    return await this.aiService.approvePrd(conversationId, prd, user.organizationId, response);
  }

  @InitFeature(FEATURE_KEY.REWIND_STEP)
  @Post('conversation/rewind-step')
  async rewindStep(@User() user, @Body() body) {
    const { conversationId, stepId } = body ?? {};
    return await this.aiService.rewindStep(conversationId, stepId, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.REGENERATE_MESSAGE)
  @Post('conversation/regenerate-message')
  async regenerateAiMessage(@User() user, @Body() body) {
    const { parentMessageId } = body ?? {};
    return await this.aiService.regenerateAiMessage(parentMessageId, user.organizationId);
  }

  @InitFeature(FEATURE_KEY.VOTE_MESSAGE)
  @Post('conversation/vote-message')
  async voteAiMessage(@User() user, @Body() body) {
    const { messageId, voteType } = body ?? {};
    return await this.aiService.voteAiMessage(messageId, voteType, user.id);
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
