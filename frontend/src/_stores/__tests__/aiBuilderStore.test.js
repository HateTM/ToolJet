import { aiService } from '@/_services/ai.service';

jest.mock('@/_services/ai.service', () => ({
  aiService: {
    sendMessage: jest.fn(),
    listConversations: jest.fn(),
    createConversation: jest.fn(),
    getConversation: jest.fn(),
    fetchZeroState: jest.fn(),
    approvePrd: jest.fn(),
    rewindStep: jest.fn(),
    voteMessage: jest.fn(),
    regenerateMessage: jest.fn(),
    promoteConversation: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import useAiBuilderStore from '@/_stores/aiBuilderStore';

const getInitialState = () => useAiBuilderStore.getState();

describe('aiBuilderStore', () => {
  const initialSnapshot = useAiBuilderStore.getState();

  beforeEach(() => {
    useAiBuilderStore.setState(initialSnapshot, true);
    jest.clearAllMocks();
    // Most tests don't care about first-message conversation creation; give it a
    // default resolved value so sendMessage's auto-create step doesn't block them.
    aiService.createConversation.mockResolvedValue({ id: 'conv-auto' });
  });

  it('has the expected initial state', () => {
    const state = getInitialState();
    expect(state.currentConversationId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.streamingMessage).toBeNull();
    expect(state.isSending).toBe(false);
    expect(state.error).toBeNull();
  });

  it('sendMessage appends the user message and opens a streaming buffer', async () => {
    aiService.sendMessage.mockImplementation(async () => {
      // Simulate the request being in-flight without resolving chunk/done yet.
      return [];
    });

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Build me a CRM' });

    const state = getInitialState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ messageType: 'user', content: 'Build me a CRM' });
    expect(aiService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'app-1', content: 'Build me a CRM' }),
      expect.any(Function),
      false
    );
  });

  it('sendMessage includes conversationId (not currentConversationId) once a conversation exists', async () => {
    useAiBuilderStore.setState({ currentConversationId: 'conv-1' });
    aiService.sendMessage.mockImplementation(async () => []);

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Follow-up' });

    expect(aiService.createConversation).not.toHaveBeenCalled();
    expect(aiService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.any(Function),
      false
    );
    const [body] = aiService.sendMessage.mock.calls[0];
    expect(body.currentConversationId).toBeUndefined();
  });

  it('sendMessage creates a conversation first when none exists yet, then sends with its id', async () => {
    aiService.createConversation.mockResolvedValue({ id: 'conv-new' });
    aiService.sendMessage.mockImplementation(async () => []);

    await getInitialState().sendMessage({ appId: 'app-1', content: 'First message' });

    expect(aiService.createConversation).toHaveBeenCalledWith({ appId: 'app-1', conversationType: 'generate' });
    expect(aiService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-new' }),
      expect.any(Function),
      false
    );
    expect(getInitialState().currentConversationId).toBe('conv-new');
  });

  it('sendMessage surfaces an error and never calls aiService.sendMessage when conversation creation fails', async () => {
    aiService.createConversation.mockRejectedValue(new Error('org over quota'));

    await getInitialState().sendMessage({ appId: 'app-1', content: 'First message' });

    expect(aiService.sendMessage).not.toHaveBeenCalled();
    const state = getInitialState();
    expect(state.error).toBe('org over quota');
    expect(state.isSending).toBe(false);
    expect(state.streamingMessage).toBeNull();
    // the optimistic user message stays, matching how a mid-stream send failure is handled
    expect(state.messages).toHaveLength(1);
  });

  it('does nothing when sendMessage is called with empty content', async () => {
    await getInitialState().sendMessage({ appId: 'app-1', content: '   ' });

    expect(aiService.sendMessage).not.toHaveBeenCalled();
    expect(getInitialState().messages).toHaveLength(0);
  });

  it('appends chunk deltas to the streaming buffer as they arrive', async () => {
    aiService.sendMessage.mockImplementation(async (body, onMessage) => {
      onMessage({ type: 'chunk', data: { content: 'Hello' } });
      onMessage({ type: 'chunk', data: { content: ' world' } });
      // leave the stream open (no `done` yet) so we can assert the buffer mid-stream
      return [];
    });

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' });

    const state = getInitialState();
    expect(state.streamingMessage).toEqual({ messageType: 'ai', content: 'Hello world' });
    expect(state.isSending).toBe(true);
  });

  it('replaces the streaming buffer with the final persisted message on done', async () => {
    const finalMessage = {
      id: 'msg-1',
      messageType: 'ai',
      content: 'Full PRD text',
      aiConversationId: 'conv-1',
      createdAt: '2026-08-16T00:00:00.000Z',
    };

    aiService.sendMessage.mockImplementation(async (body, onMessage) => {
      onMessage({ type: 'chunk', data: { content: 'Full ' } });
      onMessage({ type: 'chunk', data: { content: 'PRD text' } });
      onMessage({ type: 'done', data: { message: finalMessage } });
      return [];
    });

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' });

    const state = getInitialState();
    expect(state.streamingMessage).toBeNull();
    expect(state.isSending).toBe(false);
    expect(state.currentConversationId).toBe('conv-1');
    // user message + final ai message
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toEqual(finalMessage);
  });

  it('sets an error state and stops streaming when an error event arrives', async () => {
    aiService.sendMessage.mockImplementation(async (body, onMessage) => {
      onMessage({ type: 'chunk', data: { content: 'partial' } });
      onMessage({ type: 'error', data: { message: 'LLM gateway timed out' } });
      return [];
    });

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' });

    const state = getInitialState();
    expect(state.error).toBe('LLM gateway timed out');
    expect(state.streamingMessage).toBeNull();
    expect(state.isSending).toBe(false);
  });

  it('sets an error state when the underlying request rejects', async () => {
    aiService.sendMessage.mockRejectedValue(new Error('network down'));

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' });

    const state = getInitialState();
    expect(state.error).toBe('network down');
    expect(state.isSending).toBe(false);
    expect(state.streamingMessage).toBeNull();
  });

  it('resetConversation clears messages, streaming buffer and error state', async () => {
    aiService.sendMessage.mockImplementation(async (body, onMessage) => {
      onMessage({ type: 'error', data: { message: 'boom' } });
      return [];
    });
    await getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' });
    expect(getInitialState().error).toBe('boom');

    getInitialState().resetConversation();

    const state = getInitialState();
    expect(state.currentConversationId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.streamingMessage).toBeNull();
    expect(state.error).toBeNull();
  });

  // The panel's bootstrap effect watches handoffStatus/handoffAppId (ADR-0017), and "New chat"
  // deliberately starts an empty thread and fetches its own zero state. Clearing the handoff
  // here would re-trigger that effect and reload the very conversation the user just cleared,
  // which ADR-0010's self-consuming boolean never did.
  it('resetConversation leaves the spent handoff alone, so "New chat" is not undone by a bootstrap', () => {
    getInitialState().beginHandoff('Build a CRM', 'app-1');
    getInitialState().finishHandoff();

    getInitialState().resetConversation();

    expect(getInitialState().handoffStatus).toBe('succeeded');
    expect(getInitialState().handoffAppId).toBe('app-1');
  });

  // A mode switch throws away the thread the handoff produced, so the handoff no longer owns
  // the panel's bootstrap — leaving it in place would keep the gate shut with nothing left in
  // the store, and neither mode's thread list would ever load.
  it('setConversationType clears the handoff, releasing the panel bootstrap for the new mode', () => {
    getInitialState().beginHandoff('Build a CRM', 'app-1');
    getInitialState().finishHandoff();

    getInitialState().setConversationType('learn');

    expect(getInitialState().handoffStatus).toBe('idle');
    expect(getInitialState().handoffPrompt).toBeNull();
    expect(getInitialState().handoffAppId).toBeNull();
  });

  // ADR-0017: sendMessage reports delivery through its return value rather than by rejecting.
  // It can't reject — the chat panel calls it as a fire-and-forget click handler with no
  // .catch(), so throwing would surface as an unhandled rejection on every failed send. But
  // the homepage handoff still has to tell a delivered prompt from a lost one, because it is
  // what decides whether the prompt may be dropped from navigation state.
  describe('sendMessage delivery reporting', () => {
    it('returns true once the message has been sent', async () => {
      aiService.sendMessage.mockResolvedValue([]);
      useAiBuilderStore.setState({ currentConversationId: 'conv-1' });

      await expect(getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' })).resolves.toBe(true);
    });

    it('returns false when the send itself rejects', async () => {
      aiService.sendMessage.mockRejectedValue(new Error('network down'));
      useAiBuilderStore.setState({ currentConversationId: 'conv-1' });

      await expect(getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' })).resolves.toBe(false);
      expect(getInitialState().error).toBe('network down');
    });

    it('returns false when the first-message conversation creation fails', async () => {
      aiService.createConversation.mockRejectedValue(new Error('nope'));

      await expect(getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' })).resolves.toBe(false);
      expect(aiService.sendMessage).not.toHaveBeenCalled();
    });

    it('returns false for empty content — nothing was delivered', async () => {
      await expect(getInitialState().sendMessage({ appId: 'app-1', content: '   ' })).resolves.toBe(false);
    });

    it('returns false when the stream reports an error event, even though the request resolved', async () => {
      aiService.sendMessage.mockImplementation(async (body, onMessage) => {
        onMessage({ type: 'error', data: { message: 'model exploded' } });
        return [];
      });
      useAiBuilderStore.setState({ currentConversationId: 'conv-1' });

      await expect(getInitialState().sendMessage({ appId: 'app-1', content: 'Hi' })).resolves.toBe(false);
      expect(getInitialState().error).toBe('model exploded');
    });
  });

  // ADR-0017: the handoff is a state machine, not a one-shot boolean, precisely so a *failed*
  // handoff is distinguishable from an in-flight one — the panel has to bootstrap after the
  // former and stand down during the latter.
  describe('homepage prompt handoff', () => {
    it('starts idle, with no prompt held', () => {
      expect(getInitialState().handoffStatus).toBe('idle');
      expect(getInitialState().handoffPrompt).toBeNull();
      expect(getInitialState().handoffAppId).toBeNull();
    });

    it('beginHandoff marks it pending and holds the prompt for recovery', () => {
      getInitialState().beginHandoff('Build a CRM', 'app-1');

      expect(getInitialState().handoffStatus).toBe('pending');
      expect(getInitialState().handoffPrompt).toBe('Build a CRM');
    });

    // This store is a module singleton, and nothing clears a *succeeded* handoff — so without
    // the app it belongs to being recorded, an SPA switch to another app would still find the
    // panel's bootstrap gate closed and never load that app's threads. ADR-0010's boolean was
    // immune to this only because the first mount consumed it.
    it('records the app the handoff belongs to, and keeps it through both terminal states', () => {
      getInitialState().beginHandoff('Build a CRM', 'app-1');
      expect(getInitialState().handoffAppId).toBe('app-1');

      getInitialState().finishHandoff();
      expect(getInitialState().handoffAppId).toBe('app-1');

      getInitialState().beginHandoff('Build a CRM', 'app-1');
      getInitialState().failHandoff();
      expect(getInitialState().handoffAppId).toBe('app-1');
    });

    it('finishHandoff marks it succeeded and drops the held prompt — it was delivered', () => {
      getInitialState().beginHandoff('Build a CRM', 'app-1');

      getInitialState().finishHandoff();

      expect(getInitialState().handoffStatus).toBe('succeeded');
      expect(getInitialState().handoffPrompt).toBeNull();
    });

    it('failHandoff marks it failed and KEEPS the prompt, so it can be put back in the composer', () => {
      getInitialState().beginHandoff('Build a CRM', 'app-1');

      getInitialState().failHandoff();

      expect(getInitialState().handoffStatus).toBe('failed');
      expect(getInitialState().handoffPrompt).toBe('Build a CRM');
    });

    it('consumeHandoffPrompt returns the held prompt once, then nothing', () => {
      getInitialState().beginHandoff('Build a CRM', 'app-1');
      getInitialState().failHandoff();

      expect(getInitialState().consumeHandoffPrompt()).toBe('Build a CRM');

      expect(getInitialState().handoffPrompt).toBeNull();
      expect(getInitialState().consumeHandoffPrompt()).toBeNull();
    });

    // ADR-0017's fallback makes a failed handoff run the panel's bootstrap, which starts with
    // listConversations and can end in loadConversation or fetchZeroState. If any of those
    // nulled `error` on start, the fallback would erase the banner explaining why the prompt
    // was handed back, leaving the user with an unexplained draft in the composer.
    it.each([
      ['listConversations', () => getInitialState().listConversations('app-1')],
      ['loadConversation', () => getInitialState().loadConversation('conv-1')],
      ['fetchZeroState', () => getInitialState().fetchZeroState()],
    ])('%s does not dismiss an error raised by a failed write', async (_name, read) => {
      aiService.listConversations.mockResolvedValue([]);
      aiService.getConversation.mockResolvedValue({ id: 'conv-1', aiConversationMessages: [] });
      aiService.fetchZeroState.mockResolvedValue({ suggestions: [] });
      aiService.sendMessage.mockRejectedValue(new Error('model exploded'));
      useAiBuilderStore.setState({ currentConversationId: 'conv-1' });
      await getInitialState().sendMessage({ appId: 'app-1', content: 'Build a CRM' });
      expect(getInitialState().error).toBe('model exploded');

      await read();

      expect(getInitialState().error).toBe('model exploded');
    });

    it('consumeHandoffPrompt leaves the status alone — the panel still needs to know it failed', () => {
      getInitialState().beginHandoff('Build a CRM', 'app-1');
      getInitialState().failHandoff();

      getInitialState().consumeHandoffPrompt();

      expect(getInitialState().handoffStatus).toBe('failed');
    });
  });

  it('loadConversation populates messages from the fetched conversation', async () => {
    aiService.getConversation.mockResolvedValue({
      id: 'conv-2',
      aiConversationMessages: [{ id: 'm1', messageType: 'user', content: 'hey' }],
    });

    await getInitialState().loadConversation('conv-2');

    const state = getInitialState();
    expect(state.currentConversationId).toBe('conv-2');
    expect(state.messages).toEqual([{ id: 'm1', messageType: 'user', content: 'hey' }]);
    expect(state.isLoadingConversation).toBe(false);
  });

  it("loadConversation flattens each message's aiResponseVote relation into the votes map", async () => {
    aiService.getConversation.mockResolvedValue({
      id: 'conv-2',
      aiConversationMessages: [
        { id: 'm1', messageType: 'user', content: 'hey' },
        { id: 'm2', messageType: 'ai', content: 'a PRD', aiResponseVote: { voteType: 'up' } },
        { id: 'm3', messageType: 'ai', content: 'no vote yet' },
      ],
    });

    await getInitialState().loadConversation('conv-2');

    expect(getInitialState().votes).toEqual({ m2: 'up' });
  });

  it('fetchZeroState stores the returned zero-state payload', async () => {
    const zeroState = {
      user: { name: 'Ada', greeting: 'Welcome back', description: 'Let’s build something' },
      suggestions: [{ icon: 'sparkle', label: 'Build a CRM', action: 'Build a CRM for my sales team' }],
    };
    aiService.fetchZeroState.mockResolvedValue(zeroState);

    await getInitialState().fetchZeroState();

    expect(getInitialState().zeroState).toEqual(zeroState);
    expect(getInitialState().isZeroStateLoading).toBe(false);
  });

  describe('approvePrd', () => {
    beforeEach(() => {
      useAiBuilderStore.setState({ currentConversationId: 'conv-1' });
    });

    it('does nothing without a current conversation', async () => {
      useAiBuilderStore.setState({ currentConversationId: null });

      await getInitialState().approvePrd('some PRD text');

      expect(aiService.approvePrd).not.toHaveBeenCalled();
    });

    it('seeds the step list from the plan event, all pending', async () => {
      aiService.approvePrd.mockImplementation(async (body, onMessage) => {
        onMessage({
          type: 'plan',
          data: { steps: [{ id: 'step-1', type: 'CreateTable', description: 'Create a customers table' }] },
        });
        return [];
      });

      await getInitialState().approvePrd('PRD text');

      expect(aiService.approvePrd).toHaveBeenCalledWith(
        { conversationId: 'conv-1', prd: 'PRD text' },
        expect.any(Function)
      );
      expect(getInitialState().steps).toEqual([
        { id: 'step-1', type: 'CreateTable', description: 'Create a customers table', status: 'pending' },
      ]);
      expect(getInitialState().isApproving).toBe(true);
    });

    it('updates the matching step in place as step-progress/step-done events arrive', async () => {
      const artifact = { id: 'artifact-1', identifier: 'customers' };
      aiService.approvePrd.mockImplementation(async (body, onMessage) => {
        onMessage({
          type: 'plan',
          data: { steps: [{ id: 'step-1', type: 'CreateTable', description: 'Create a table' }] },
        });
        onMessage({ type: 'step-progress', data: { step: 1, of: 1, description: 'Create a table' } });
        onMessage({ type: 'step-done', data: { step: 1, of: 1, artifact } });
        onMessage({ type: 'done', data: { succeeded: 1, total: 1 } });
        return [];
      });

      await getInitialState().approvePrd('PRD text');

      const state = getInitialState();
      expect(state.steps[0]).toMatchObject({ status: 'succeeded', artifact });
      expect(state.isApproving).toBe(false);
    });

    it('marks a step failed on step-failed and posts the failure message on done', async () => {
      const failureMessage = { id: 'failure-msg', messageType: 'ai', content: 'The build stopped at step 1 of 1' };
      aiService.approvePrd.mockImplementation(async (body, onMessage) => {
        onMessage({
          type: 'plan',
          data: { steps: [{ id: 'step-1', type: 'CreateQuery', description: 'Query orders' }] },
        });
        onMessage({ type: 'step-failed', data: { step: 1, of: 1, message: 'Unsupported step type "CreateQuery"' } });
        onMessage({ type: 'done', data: { message: failureMessage, succeeded: 0, total: 1 } });
        return [];
      });

      await getInitialState().approvePrd('PRD text');

      const state = getInitialState();
      expect(state.steps[0]).toMatchObject({
        status: 'failed',
        errorMessage: 'Unsupported step type "CreateQuery"',
      });
      expect(state.messages).toContainEqual(failureMessage);
      expect(state.isApproving).toBe(false);
    });

    it('sets an error state and stops approving on an error event', async () => {
      aiService.approvePrd.mockImplementation(async (body, onMessage) => {
        onMessage({ type: 'error', data: { message: 'Failed to generate a build plan' } });
        return [];
      });

      await getInitialState().approvePrd('PRD text');

      const state = getInitialState();
      expect(state.error).toBe('Failed to generate a build plan');
      expect(state.isApproving).toBe(false);
    });

    it('sets an error state when the underlying request rejects', async () => {
      aiService.approvePrd.mockRejectedValue(new Error('network down'));

      await getInitialState().approvePrd('PRD text');

      const state = getInitialState();
      expect(state.error).toBe('network down');
      expect(state.isApproving).toBe(false);
    });
  });

  describe('rewindStep', () => {
    beforeEach(() => {
      useAiBuilderStore.setState({
        currentConversationId: 'conv-1',
        steps: [
          { id: 'step-1', type: 'CreateComponent', description: 'Create the Orders page', status: 'succeeded' },
          { id: 'step-2', type: 'CreateComponent', description: 'Add a Save button', status: 'succeeded' },
          { id: 'step-3', type: 'CreateComponent', description: 'Add a welcome text', status: 'succeeded' },
        ],
      });
    });

    it('does nothing without a current conversation', async () => {
      useAiBuilderStore.setState({ currentConversationId: null });

      await getInitialState().rewindStep('step-1');

      expect(aiService.rewindStep).not.toHaveBeenCalled();
    });

    it('does nothing without a stepId', async () => {
      await getInitialState().rewindStep(null);

      expect(aiService.rewindStep).not.toHaveBeenCalled();
    });

    it('sends the current conversationId and the given stepId', async () => {
      aiService.rewindStep.mockResolvedValue({ rewoundTo: 'step-1', undone: ['step-2', 'step-3'] });

      await getInitialState().rewindStep('step-1');

      expect(aiService.rewindStep).toHaveBeenCalledWith({ conversationId: 'conv-1', stepId: 'step-1' });
    });

    it('drops every undone step from the local step list, keeping the rewound-to step', async () => {
      aiService.rewindStep.mockResolvedValue({ rewoundTo: 'step-1', undone: ['step-2', 'step-3'] });

      await getInitialState().rewindStep('step-1');

      const state = getInitialState();
      expect(state.steps.map((step) => step.id)).toEqual(['step-1']);
      expect(state.rewindingStepId).toBeNull();
    });

    it('sets rewindingStepId to the target while the request is in flight', async () => {
      let resolveRewind;
      aiService.rewindStep.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRewind = resolve;
          })
      );

      const pending = getInitialState().rewindStep('step-2');
      expect(getInitialState().rewindingStepId).toBe('step-2');

      resolveRewind({ rewoundTo: 'step-2', undone: ['step-3'] });
      await pending;
      expect(getInitialState().rewindingStepId).toBeNull();
    });

    it('sets an error state and leaves the step list untouched when the request rejects', async () => {
      aiService.rewindStep.mockRejectedValue(new Error('Can only rewind to a completed step'));

      await getInitialState().rewindStep('step-2');

      const state = getInitialState();
      expect(state.error).toBe('Can only rewind to a completed step');
      expect(state.rewindingStepId).toBeNull();
      expect(state.steps).toHaveLength(3);
    });
  });

  describe('voteMessage', () => {
    it('does nothing without a messageId or voteType', async () => {
      await getInitialState().voteMessage(null, 'up');
      await getInitialState().voteMessage('msg-1', null);

      expect(aiService.voteMessage).not.toHaveBeenCalled();
    });

    it('sets the vote optimistically before the request resolves', async () => {
      let resolveVote;
      aiService.voteMessage.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveVote = resolve;
          })
      );

      const pending = getInitialState().voteMessage('msg-1', 'up');
      expect(getInitialState().votes).toEqual({ 'msg-1': 'up' });

      resolveVote({});
      await pending;
      expect(aiService.voteMessage).toHaveBeenCalledWith('msg-1', 'up');
    });

    it('rolls back to the previous vote and sets an error when the request rejects', async () => {
      useAiBuilderStore.setState({ votes: { 'msg-1': 'up' } });
      aiService.voteMessage.mockRejectedValue(new Error('network down'));

      await getInitialState().voteMessage('msg-1', 'down');

      const state = getInitialState();
      expect(state.votes).toEqual({ 'msg-1': 'up' });
      expect(state.error).toBe('network down');
    });

    it('rolls back to no vote (not a stale one) when there was none before', async () => {
      aiService.voteMessage.mockRejectedValue(new Error('network down'));

      await getInitialState().voteMessage('msg-1', 'up');

      expect(getInitialState().votes).toEqual({});
    });
  });

  describe('regenerateMessage', () => {
    beforeEach(() => {
      useAiBuilderStore.setState({
        messages: [
          { id: 'user-msg-1', messageType: 'user', content: 'Build me a CRM' },
          { id: 'ai-msg-1', messageType: 'ai', content: 'Here is a PRD', parentId: 'user-msg-1' },
        ],
      });
    });

    it('does nothing without a parentMessageId', async () => {
      await getInitialState().regenerateMessage(null);

      expect(aiService.regenerateMessage).not.toHaveBeenCalled();
    });

    it('sets regeneratingMessageId while the request is in flight', async () => {
      let resolveRegenerate;
      aiService.regenerateMessage.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveRegenerate = resolve;
          })
      );

      const pending = getInitialState().regenerateMessage('user-msg-1');
      expect(getInitialState().regeneratingMessageId).toBe('user-msg-1');

      resolveRegenerate({
        id: 'ai-msg-2',
        messageType: 'ai',
        content: 'Regenerated PRD',
        parentId: 'user-msg-1',
        isLatest: true,
      });
      await pending;
      expect(getInitialState().regeneratingMessageId).toBeNull();
    });

    it('replaces the stale AI reply in place with the newly regenerated one', async () => {
      aiService.regenerateMessage.mockResolvedValue({
        id: 'ai-msg-2',
        messageType: 'ai',
        content: 'Regenerated PRD',
        parentId: 'user-msg-1',
        isLatest: true,
      });

      await getInitialState().regenerateMessage('user-msg-1');

      const state = getInitialState();
      expect(state.messages).toHaveLength(2);
      expect(state.messages[1]).toMatchObject({ id: 'ai-msg-2', content: 'Regenerated PRD' });
    });

    it('sets an error state and clears regeneratingMessageId when the request rejects', async () => {
      aiService.regenerateMessage.mockRejectedValue(
        new Error('Only the latest message in the conversation can be regenerated')
      );

      await getInitialState().regenerateMessage('user-msg-1');

      const state = getInitialState();
      expect(state.error).toBe('Only the latest message in the conversation can be regenerated');
      expect(state.regeneratingMessageId).toBeNull();
      // the stale message list is left untouched on failure
      expect(state.messages).toHaveLength(2);
    });
  });

  describe('Learn conversations', () => {
    it('starts in generate mode', () => {
      expect(getInitialState().conversationType).toBe('generate');
    });

    it('routes a Learn message to the docs endpoint instead of the PRD one', async () => {
      useAiBuilderStore.setState({ conversationType: 'learn', currentConversationId: 'learn-1' });
      aiService.sendMessage.mockImplementation(async () => []);

      await getInitialState().sendMessage({ appId: 'app-1', content: 'What pages do I have?' });

      expect(aiService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'learn-1', conversationType: 'learn' }),
        expect.any(Function),
        true
      );
    });

    it('creates a learn conversation for the first message of a Learn thread', async () => {
      useAiBuilderStore.setState({ conversationType: 'learn' });
      aiService.createConversation.mockResolvedValue({ id: 'learn-new' });
      aiService.sendMessage.mockImplementation(async () => []);

      await getInitialState().sendMessage({ appId: 'app-1', content: 'What does this app do?' });

      expect(aiService.createConversation).toHaveBeenCalledWith({ appId: 'app-1', conversationType: 'learn' });
    });

    it('lists the threads of whichever mode is current', async () => {
      aiService.listConversations.mockResolvedValue([]);
      useAiBuilderStore.setState({ conversationType: 'learn' });

      await getInitialState().listConversations('app-1');

      expect(aiService.listConversations).toHaveBeenCalledWith('app-1', 'learn');
    });

    it('setConversationType drops the current thread — a conversation belongs to exactly one type', () => {
      useAiBuilderStore.setState({
        currentConversationId: 'conv-1',
        messages: [{ id: 'm1', messageType: 'user', content: 'hi' }],
        steps: [{ id: 'step-1', status: 'succeeded' }],
        votes: { m1: 'up' },
        error: 'stale error',
      });

      getInitialState().setConversationType('learn');

      const state = getInitialState();
      expect(state.conversationType).toBe('learn');
      expect(state.currentConversationId).toBeNull();
      expect(state.messages).toEqual([]);
      expect(state.steps).toEqual([]);
      expect(state.votes).toEqual({});
      expect(state.error).toBeNull();
    });

    it('setConversationType is a no-op when the mode is unchanged, so an in-flight thread survives', () => {
      useAiBuilderStore.setState({ conversationType: 'learn', currentConversationId: 'learn-1' });

      getInitialState().setConversationType('learn');

      expect(getInitialState().currentConversationId).toBe('learn-1');
    });

    describe('promoteConversation', () => {
      beforeEach(() => {
        useAiBuilderStore.setState({
          conversationType: 'learn',
          currentConversationId: 'learn-1',
          messages: [
            { id: 'q-1', messageType: 'user', content: 'How do orders list?' },
            { id: 'a-1', messageType: 'ai', content: 'Via list_orders.', parentId: 'q-1' },
          ],
        });
      });

      it('switches the panel to the new Generate conversation and its context seed', async () => {
        aiService.promoteConversation.mockResolvedValue({
          id: 'generate-1',
          conversationType: 'generate',
          messages: [{ id: 'seed-1', messageType: 'user', content: 'Context carried over...' }],
        });

        const result = await getInitialState().promoteConversation('a-1');

        expect(aiService.promoteConversation).toHaveBeenCalledWith({
          conversationId: 'learn-1',
          messageId: 'a-1',
        });
        const state = getInitialState();
        expect(state.conversationType).toBe('generate');
        expect(state.currentConversationId).toBe('generate-1');
        expect(state.messages).toEqual([{ id: 'seed-1', messageType: 'user', content: 'Context carried over...' }]);
        expect(state.promotingMessageId).toBeNull();
        expect(result).toMatchObject({ id: 'generate-1' });
      });

      it('leaves the panel on the Learn thread when the request fails', async () => {
        aiService.promoteConversation.mockRejectedValue(new Error('Conversation not found'));

        const result = await getInitialState().promoteConversation('a-1');

        const state = getInitialState();
        expect(result).toBeNull();
        expect(state.conversationType).toBe('learn');
        expect(state.currentConversationId).toBe('learn-1');
        expect(state.messages).toHaveLength(2);
        expect(state.error).toBe('Conversation not found');
        expect(state.promotingMessageId).toBeNull();
      });

      it('does nothing without a conversation or a message to promote', async () => {
        await getInitialState().promoteConversation(undefined);
        useAiBuilderStore.setState({ currentConversationId: null });
        await getInitialState().promoteConversation('a-1');

        expect(aiService.promoteConversation).not.toHaveBeenCalled();
      });
    });
  });
});
