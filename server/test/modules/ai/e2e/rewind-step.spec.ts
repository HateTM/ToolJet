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
} from 'test-helper';
import { AgentsService } from '@modules/ai/services/agents.service';
import { AiConversation } from '@entities/ai_conversation.entity';
import { AiConversationMessage } from '@entities/ai_conversation_message.entity';
import { Step } from '@entities/step.entity';
import { Artifact } from '@entities/artifact.entity';
import { Component } from '@entities/component.entity';

/**
 * Exercises rewindStep (ADR-0008) end to end: real components created via AgentsService,
 * a real HTTP call to POST /api/ai/conversation/rewind-step, then real DB assertions that
 * the App itself — not just the Step ledger — reflects the undo.
 *
 * Seeds Steps/Artifacts directly (via AgentsService + saveEntity) rather than driving them
 * through approvePrd's LLM-backed planning — this spec is about rewindStep's own undo
 * behavior, which doesn't care how the Steps/Artifacts it's given came to exist, and this
 * way nothing here needs to stub the AI gateway.
 */
/** @group platform */
describe('AiController.rewindStep', () => {
  let app: INestApplication;
  let agentsService: AgentsService;

  beforeAll(async () => {
    ({ app } = await initTestApp({ edition: 'ee', plan: 'enterprise' }));
    agentsService = app.get(AgentsService, { strict: false });
  });

  afterAll(async () => {
    await closeTestApp(app);
  }, 60_000);

  async function setupConversation(applicationId: string, userId: string) {
    const conversation = await saveEntity(AiConversation, {
      appId: applicationId,
      userId,
      conversationType: 'generate',
    });
    const message = await saveEntity(AiConversationMessage, {
      aiConversationId: conversation.id,
      messageType: 'ai',
      content: 'PRD text',
      isLatest: true,
    });
    return { conversation, message };
  }

  // A 3-step CreateComponent-only plan (Page -> Button -> Text), all succeeded, matching
  // the DB shape a real approvePrd run would have left.
  async function seedThreeStepPlan(
    conversationId: string,
    messageId: string,
    appVersionId: string,
    organizationId: string
  ) {
    const page = await agentsService.CreateComponent(appVersionId, organizationId, 'Page', { name: 'Orders' });
    const button = await agentsService.CreateComponent(appVersionId, organizationId, 'Button', {
      pageId: page.id,
      text: 'Save',
    });
    const text = await agentsService.CreateComponent(appVersionId, organizationId, 'Text', {
      pageId: page.id,
      text: 'Welcome',
    });

    const contents = [page, button, text];
    const artifacts = [];
    for (const content of contents) {
      artifacts.push(await saveEntity(Artifact, { conversationId, messageId, content, identifier: content.id }));
    }

    const descriptions = ['Create the Orders page', 'Add a Save button', 'Add a welcome text'];
    const steps: Step[] = [];
    for (let index = 0; index < descriptions.length; index++) {
      steps.push(
        await saveEntity(Step, {
          conversationId,
          messageId,
          order: index,
          type: 'CreateComponent',
          description: descriptions[index],
          status: 'succeeded',
          attempts: 1,
          artifactId: artifacts[index].id,
        })
      );
    }

    return { page, button, text, artifacts, steps };
  }

  it('undoes every step after the rewind target, deleting their components, and resets them to pending', async () => {
    const { user } = await createUser(app, { email: 'rewind1@tooljet.io', groups: ['all_users', 'admin'] });
    const loggedUser = await login(app, user.email);
    const { application, appVersion } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
    const { conversation, message } = await setupConversation(application.id, user.id);

    const { page, button, text, steps } = await seedThreeStepPlan(
      conversation.id,
      message.id,
      appVersion.id,
      user.organizationId
    );

    const response = await request(app.getHttpServer())
      .post('/api/ai/conversation/rewind-step')
      .set('tj-workspace-id', user.organizationId)
      .set('Cookie', loggedUser.tokenCookie)
      .send({ conversationId: conversation.id, stepId: steps[0].id });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ rewoundTo: steps[0].id, undone: [steps[1].id, steps[2].id] });

    // The target Page component still exists — rewind returns to the state right after it
    // finished, not before it.
    expect(await findEntity(Component, { id: page.id })).not.toBeNull();

    // Both later components are gone from the App itself, not just from the Step ledger.
    expect(await findEntity(Component, { id: button.id })).toBeNull();
    expect(await findEntity(Component, { id: text.id })).toBeNull();

    const buttonStep = await findEntity(Step, { id: steps[1].id });
    const textStep = await findEntity(Step, { id: steps[2].id });
    expect(buttonStep).toMatchObject({ status: 'pending', artifactId: null });
    expect(textStep).toMatchObject({ status: 'pending', artifactId: null });

    const targetStep = await findEntity(Step, { id: steps[0].id });
    expect(targetStep.status).toBe('succeeded');

    expect(await findEntity(Artifact, { id: steps[1].artifactId })).toBeNull();
    expect(await findEntity(Artifact, { id: steps[2].artifactId })).toBeNull();
  });

  it('a partial-plan rewind only undoes steps after the target, leaving earlier succeeded steps untouched', async () => {
    const { user } = await createUser(app, { email: 'rewind2@tooljet.io', groups: ['all_users', 'admin'] });
    const loggedUser = await login(app, user.email);
    const { application, appVersion } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
    const { conversation, message } = await setupConversation(application.id, user.id);

    const { page, button, text, steps } = await seedThreeStepPlan(
      conversation.id,
      message.id,
      appVersion.id,
      user.organizationId
    );

    // Rewind to the middle step (the Button) — not the first, not the last.
    const response = await request(app.getHttpServer())
      .post('/api/ai/conversation/rewind-step')
      .set('tj-workspace-id', user.organizationId)
      .set('Cookie', loggedUser.tokenCookie)
      .send({ conversationId: conversation.id, stepId: steps[1].id });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ rewoundTo: steps[1].id, undone: [steps[2].id] });

    // Page and Button (at/before the target) are untouched; only the Text is undone.
    expect(await findEntity(Component, { id: page.id })).not.toBeNull();
    expect(await findEntity(Component, { id: button.id })).not.toBeNull();
    expect(await findEntity(Component, { id: text.id })).toBeNull();

    const pageStep = await findEntity(Step, { id: steps[0].id });
    const buttonStep = await findEntity(Step, { id: steps[1].id });
    expect(pageStep.status).toBe('succeeded');
    expect(buttonStep.status).toBe('succeeded');
  });

  it("does not touch a separately approved PRD's steps, even in the same conversation", async () => {
    const { user } = await createUser(app, { email: 'rewind3@tooljet.io', groups: ['all_users', 'admin'] });
    const loggedUser = await login(app, user.email);
    const { application, appVersion } = await createAppWithDependencies(app, user, { isDataSourceNeeded: false });
    const { conversation, message: messageA } = await setupConversation(application.id, user.id);

    const planA = await seedThreeStepPlan(conversation.id, messageA.id, appVersion.id, user.organizationId);

    // A second, separately approved PRD in the same conversation — its own messageId.
    const messageB = await saveEntity(AiConversationMessage, {
      aiConversationId: conversation.id,
      messageType: 'ai',
      content: 'Second PRD text',
      isLatest: true,
    });
    const planB = await seedThreeStepPlan(conversation.id, messageB.id, appVersion.id, user.organizationId);

    const response = await request(app.getHttpServer())
      .post('/api/ai/conversation/rewind-step')
      .set('tj-workspace-id', user.organizationId)
      .set('Cookie', loggedUser.tokenCookie)
      .send({ conversationId: conversation.id, stepId: planA.steps[0].id });

    expect(response.statusCode).toBe(201);
    expect(response.body.undone).toEqual([planA.steps[1].id, planA.steps[2].id]);

    // Plan B's components/steps are entirely untouched by rewinding plan A.
    expect(await findEntity(Component, { id: planB.button.id })).not.toBeNull();
    expect(await findEntity(Component, { id: planB.text.id })).not.toBeNull();
    const planBButtonStep = await findEntity(Step, { id: planB.steps[1].id });
    expect(planBButtonStep.status).toBe('succeeded');
  });

  it("404s when the given step does not belong to the caller's conversation", async () => {
    const { user } = await createUser(app, { email: 'rewind4@tooljet.io', groups: ['all_users', 'admin'] });
    const loggedUser = await login(app, user.email);

    const response = await request(app.getHttpServer())
      .post('/api/ai/conversation/rewind-step')
      .set('tj-workspace-id', user.organizationId)
      .set('Cookie', loggedUser.tokenCookie)
      .send({ conversationId: 'not-a-real-conversation-id', stepId: 'not-a-real-step-id' });

    expect(response.statusCode).toBe(404);
  });
});
