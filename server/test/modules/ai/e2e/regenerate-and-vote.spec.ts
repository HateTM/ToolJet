import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import {
  initTestApp,
  closeTestApp,
  createUser,
  login,
  createAppWithDependencies,
  saveEntity,
  findEntity,
  countEntities,
} from 'test-helper';
import { AiUtilService } from '@modules/ai/util.service';
import { AiConversation } from '@entities/ai_conversation.entity';
import { AiConversationMessage } from '@entities/ai_conversation_message.entity';
import { AiResponseVote } from '@entities/ai_response_vote.entity';

/**
 * Exercises regenerate-message and vote-message (ADR-0009) end to end: real
 * AiConversationMessage/AiResponseVote rows, real HTTP calls, real DB assertions.
 * Stubs AiUtilService.AIGatewayGenerate so regenerate doesn't hit a real LLM endpoint —
 * this spec is about the branch/isLatest and vote-upsert mechanics, not LLM output.
 */
/** @group platform */
describe('AiController regenerate-message / vote-message', () => {
  let app: INestApplication;
  let aiUtilService: AiUtilService;

  beforeAll(async () => {
    ({ app } = await initTestApp({ edition: 'ee', plan: 'enterprise' }));
    aiUtilService = app.get(AiUtilService, { strict: false });
  });

  afterAll(async () => {
    await closeTestApp(app);
  }, 60_000);

  async function setupConversation(applicationId: string, userId: string) {
    return await saveEntity(AiConversation, {
      appId: applicationId,
      userId,
      conversationType: 'generate',
    });
  }

  describe('POST /api/ai/conversation/regenerate-message', () => {
    it('regenerates the latest turn: marks the stale reply isLatest:false and creates a new sibling with the same parentId', async () => {
      const { user } = await createUser(app, { email: 'regen1@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);
      const { application } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
      const conversation = await setupConversation(application.id, user.id);

      const userMessage = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'user',
        content: 'Build me a CRM',
        isLatest: true,
      });
      const staleReply = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'ai',
        content: 'Here is a first-draft PRD',
        parentId: userMessage.id,
        isLatest: true,
      });

      jest.spyOn(aiUtilService, 'AIGatewayGenerate').mockResolvedValueOnce({ text: 'Regenerated PRD text' } as any);

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/regenerate-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ parentMessageId: userMessage.id });

      expect(response.statusCode).toBe(201);
      expect(response.body).toMatchObject({
        messageType: 'ai',
        content: 'Regenerated PRD text',
        parentId: userMessage.id,
        isLatest: true,
      });

      const staleAfter = await findEntity(AiConversationMessage, { id: staleReply.id });
      expect(staleAfter.isLatest).toBe(false);

      const newReply = await findEntity(AiConversationMessage, { id: response.body.id });
      expect(newReply).toMatchObject({ isLatest: true, parentId: userMessage.id, content: 'Regenerated PRD text' });
    });

    it("rejects regenerating anything but the conversation's current last turn", async () => {
      const { user } = await createUser(app, { email: 'regen2@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);
      const { application } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
      const conversation = await setupConversation(application.id, user.id);

      const firstUserMessage = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'user',
        content: 'Build me a CRM',
        isLatest: true,
      });
      await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'ai',
        content: 'Here is a PRD',
        parentId: firstUserMessage.id,
        isLatest: true,
      });
      const secondUserMessage = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'user',
        content: 'Add a status field',
        isLatest: true,
      });
      await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'ai',
        content: 'Updated PRD',
        parentId: secondUserMessage.id,
        isLatest: true,
      });

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/regenerate-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ parentMessageId: firstUserMessage.id });

      expect(response.statusCode).toBe(400);
    });

    it('404s when parentMessageId does not exist', async () => {
      const { user } = await createUser(app, { email: 'regen3@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/regenerate-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ parentMessageId: 'not-a-real-message-id' });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/ai/conversation/vote-message', () => {
    it('creates a vote for a message with no existing vote', async () => {
      const { user } = await createUser(app, { email: 'vote1@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);
      const { application } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
      const conversation = await setupConversation(application.id, user.id);
      const aiMessage = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'ai',
        content: 'A PRD',
        isLatest: true,
      });

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/vote-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ messageId: aiMessage.id, voteType: 'up' });

      expect(response.statusCode).toBe(201);
      const vote = await findEntity(AiResponseVote, { aiConversationMessageId: aiMessage.id });
      expect(vote).toMatchObject({ voteType: 'up' });
    });

    it('overwrites the existing vote row instead of creating a second one', async () => {
      const { user } = await createUser(app, { email: 'vote2@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);
      const { application } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
      const conversation = await setupConversation(application.id, user.id);
      const aiMessage = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'ai',
        content: 'A PRD',
        isLatest: true,
      });

      await request(app.getHttpServer())
        .post('/api/ai/conversation/vote-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ messageId: aiMessage.id, voteType: 'up' });

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/vote-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ messageId: aiMessage.id, voteType: 'down' });

      expect(response.statusCode).toBe(201);

      // Exactly one vote row for this message, now flipped to 'down' — not a second row.
      expect(await countEntities(AiResponseVote, { where: { aiConversationMessageId: aiMessage.id } })).toBe(1);
      const vote = await findEntity(AiResponseVote, { aiConversationMessageId: aiMessage.id });
      expect(vote.voteType).toBe('down');
    });

    it('rejects an invalid voteType', async () => {
      const { user } = await createUser(app, { email: 'vote3@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);
      const { application } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
      const conversation = await setupConversation(application.id, user.id);
      const aiMessage = await saveEntity(AiConversationMessage, {
        aiConversationId: conversation.id,
        messageType: 'ai',
        content: 'A PRD',
        isLatest: true,
      });

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/vote-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ messageId: aiMessage.id, voteType: 'sideways' });

      expect(response.statusCode).toBe(400);
    });

    it('404s when the message does not exist', async () => {
      const { user } = await createUser(app, { email: 'vote4@tooljet.io', groups: ['all_users', 'admin'] });
      const loggedUser = await login(app, user.email);

      const response = await request(app.getHttpServer())
        .post('/api/ai/conversation/vote-message')
        .set('tj-workspace-id', user.organizationId)
        .set('Cookie', loggedUser.tokenCookie)
        .send({ messageId: 'not-a-real-message-id', voteType: 'up' });

      expect(response.statusCode).toBe(404);
    });
  });
});
