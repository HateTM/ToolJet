import { aiService } from '@/_services/ai.service';

jest.mock('@/_services/ai.service', () => ({
  aiService: {
    sendMessage: jest.fn(),
    listConversations: jest.fn(),
    createConversation: jest.fn(),
    getConversation: jest.fn(),
    fetchZeroState: jest.fn(),
    approvePrd: jest.fn(),
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
});
