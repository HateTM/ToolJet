import { Controller, Get, Post, Body, Param, Res, Query, UseGuards } from '@nestjs/common';
import { User } from '@modules/app/decorators/user.decorator';
import { UserPermissionsDecorator } from '@modules/app/decorators/user-permission.decorator';
import { UserPermissions } from '@modules/ability/types';
import { Response } from 'express';
import { IAiController } from './interfaces/IController';
import { InitFeature } from '@modules/app/decorators/init-feature.decorator';
import { FEATURE_KEY } from './constants';
import { AiService } from './service';
import { JwtAuthGuard } from '@modules/session/guards/jwt-auth.guard';
import { FeatureAbilityGuard } from './ability/guard';
import { InitModule } from '@modules/app/decorators/init-module';
import { MODULES } from '@modules/app/constants/modules';

// No global APP_GUARD exists in this app — every route must declare its own guards
// (see tooljet-db/controller.ts). JwtAuthGuard is what populates request.user for
// @User(); without it the handlers crash on undefined (live-stack 500 regression).
@Controller('ai')
@InitModule(MODULES.AI)
@UseGuards(JwtAuthGuard, FeatureAbilityGuard)
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

  // Ticket #20: structured schema preview before approval — generates (or reuses) the plan
  // for the latest PRD and returns it as JSON; nothing executes and no SSE is opened.
  @InitFeature(FEATURE_KEY.PREVIEW_PLAN)
  @Post('conversation/preview-plan')
  async previewPlan(@User() user, @UserPermissionsDecorator() userPermissions: UserPermissions, @Body() body) {
    const { conversationId, dataSourceId } = body ?? {};
    return await this.aiService.previewPlan(conversationId, user, userPermissions, dataSourceId);
  }

  @InitFeature(FEATURE_KEY.REWIND_STEP)
  @Post('conversation/rewind-step')
  async rewindStep(@User() user, @Body() body) {
    const { conversationId, stepId, inclusive } = body ?? {};
    // `inclusive` (ticket #15): the "undo this build" offer after a failed plan rewinds
    // inclusively to the plan's first step, so the first step's Artifact is discarded too.
    return await this.aiService.rewindStep(conversationId, stepId, user.id, user.organizationId, inclusive === true);
  }

  // Ticket #21: records the user's decision to skip a step of a running plan. Not SSE — the
  // execution loop picks the new status up at its next checkpoint.
  @InitFeature(FEATURE_KEY.SKIP_STEP)
  @Post('conversation/skip-step')
  async skipStep(@User() user, @Body() body) {
    const { conversationId, stepId } = body ?? {};
    return await this.aiService.skipStep(conversationId, stepId, user.id);
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

  @InitFeature(FEATURE_KEY.GET_ACTIVE_RUN)
  @Get('conversation/:conversationId/active-run')
  async getActiveRun(@User() user, @Param('conversationId') conversationId: string) {
    return await this.aiService.getActiveRun(conversationId, user.id);
  }
}
