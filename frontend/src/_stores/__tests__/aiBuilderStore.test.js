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
      expect.any(Function)
    );
  });

  it('sendMessage includes conversationId (not currentConversationId) once a conversation exists', async () => {
    useAiBuilderStore.setState({ currentConversationId: 'conv-1' });
    aiService.sendMessage.mockImplementation(async () => []);

    await getInitialState().sendMessage({ appId: 'app-1', content: 'Follow-up' });

    expect(aiService.createConversation).not.toHaveBeenCalled();
    expect(aiService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      expect.any(Function)
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
      expect.any(Function)
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
});
