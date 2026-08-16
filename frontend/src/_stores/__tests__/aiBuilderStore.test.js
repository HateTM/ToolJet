import { aiService } from '@/_services/ai.service';

jest.mock('@/_services/ai.service', () => ({
  aiService: {
    sendMessage: jest.fn(),
    listConversations: jest.fn(),
    createConversation: jest.fn(),
    getConversation: jest.fn(),
    fetchZeroState: jest.fn(),
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
});
