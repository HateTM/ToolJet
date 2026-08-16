import { immer } from 'zustand/middleware/immer';
import { create, zustandDevTools } from './utils';
import { aiService } from '@/_services/ai.service';

// AI Builder conversation state - drives the AI chat panel in the left sidebar
// (send message -> streamed PRD in chat). Keeps the message history for the
// active conversation plus a separate "streamingMessage" buffer that
// accumulates `chunk` SSE deltas until the `done` event replaces it with the
// authoritative, persisted AI message.
const initialState = {
  currentConversationId: null,
  conversations: [],
  messages: [],
  streamingMessage: null, // { messageType: 'ai', content: string } while a response is in flight
  isSending: false,
  isLoadingConversation: false,
  isLoadingConversations: false,
  zeroState: null,
  isZeroStateLoading: false,
  error: null,
};

const buildErrorMessage = (error, fallback) => error?.error || error?.data?.message || error?.message || fallback;

const useAiBuilderStore = create(
  zustandDevTools(
    immer((set, get) => ({
      ...initialState,

      resetConversation: () => {
        set(
          (state) => {
            state.currentConversationId = null;
            state.messages = [];
            state.streamingMessage = null;
            state.isSending = false;
            state.error = null;
          },
          false,
          'aiBuilder/resetConversation'
        );
      },

      clearError: () => {
        set(
          (state) => {
            state.error = null;
          },
          false,
          'aiBuilder/clearError'
        );
      },

      fetchZeroState: async () => {
        set(
          (state) => {
            state.isZeroStateLoading = true;
            state.error = null;
          },
          false,
          'aiBuilder/fetchZeroState/start'
        );
        try {
          const zeroState = await aiService.fetchZeroState();
          set(
            (state) => {
              state.zeroState = zeroState;
              state.isZeroStateLoading = false;
            },
            false,
            'aiBuilder/fetchZeroState/success'
          );
          return zeroState;
        } catch (error) {
          set(
            (state) => {
              state.isZeroStateLoading = false;
              state.error = buildErrorMessage(error, 'Failed to load suggestions');
            },
            false,
            'aiBuilder/fetchZeroState/error'
          );
          return null;
        }
      },

      listConversations: async (appId, conversationType = 'generate') => {
        set(
          (state) => {
            state.isLoadingConversations = true;
            state.error = null;
          },
          false,
          'aiBuilder/listConversations/start'
        );
        try {
          const conversations = await aiService.listConversations(appId, conversationType);
          set(
            (state) => {
              state.conversations = conversations || [];
              state.isLoadingConversations = false;
            },
            false,
            'aiBuilder/listConversations/success'
          );
          return conversations;
        } catch (error) {
          set(
            (state) => {
              state.isLoadingConversations = false;
              state.error = buildErrorMessage(error, 'Failed to load conversations');
            },
            false,
            'aiBuilder/listConversations/error'
          );
          return [];
        }
      },

      loadConversation: async (conversationId) => {
        set(
          (state) => {
            state.isLoadingConversation = true;
            state.error = null;
          },
          false,
          'aiBuilder/loadConversation/start'
        );
        try {
          const conversation = await aiService.getConversation(conversationId);
          set(
            (state) => {
              state.currentConversationId = conversation?.id ?? conversationId;
              state.messages = conversation?.aiConversationMessages || conversation?.messages || [];
              state.streamingMessage = null;
              state.isLoadingConversation = false;
            },
            false,
            'aiBuilder/loadConversation/success'
          );
          return conversation;
        } catch (error) {
          set(
            (state) => {
              state.isLoadingConversation = false;
              state.error = buildErrorMessage(error, 'Failed to load conversation');
            },
            false,
            'aiBuilder/loadConversation/error'
          );
          return null;
        }
      },

      // Creates a brand new conversation, or resolves the existing one for the app
      // (backend decides based on currentConversationId/handoff).
      createConversation: async ({ appId, conversationType = 'generate', currentConversationId, handoff } = {}) => {
        set(
          (state) => {
            state.isLoadingConversation = true;
            state.error = null;
          },
          false,
          'aiBuilder/createConversation/start'
        );
        try {
          const conversation = await aiService.createConversation({
            appId,
            conversationType,
            ...(currentConversationId ? { currentConversationId } : {}),
            ...(handoff ? { handoff } : {}),
          });
          set(
            (state) => {
              state.currentConversationId = conversation?.id ?? null;
              state.messages = conversation?.aiConversationMessages || conversation?.messages || [];
              state.streamingMessage = null;
              state.isLoadingConversation = false;
            },
            false,
            'aiBuilder/createConversation/success'
          );
          return conversation;
        } catch (error) {
          set(
            (state) => {
              state.isLoadingConversation = false;
              state.error = buildErrorMessage(error, 'Failed to start conversation');
            },
            false,
            'aiBuilder/createConversation/error'
          );
          throw error;
        }
      },

      // Sends a user message, appending it optimistically, then streams the AI
      // response: `chunk` events append to `streamingMessage.content`, `done`
      // replaces the streaming buffer with the authoritative persisted message,
      // `error` surfaces a failure and stops "streaming".
      sendMessage: async ({ appId, content, conversationType = 'generate' }) => {
        const trimmedContent = (content ?? '').trim();
        if (!trimmedContent) return;

        const userMessage = {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          messageType: 'user',
          content: trimmedContent,
          createdAt: new Date().toISOString(),
        };

        set(
          (state) => {
            state.messages.push(userMessage);
            state.streamingMessage = { messageType: 'ai', content: '' };
            state.isSending = true;
            state.error = null;
          },
          false,
          'aiBuilder/sendMessage/start'
        );

        // The backend requires an existing conversationId (it never creates one
        // implicitly) — so the very first message of a thread has to create the
        // conversation here. Calling aiService directly (not the `createConversation`
        // action) avoids that action's success handler clobbering `state.messages`
        // with the freshly-created (empty) conversation's message list.
        let conversationId = get().currentConversationId;
        if (!conversationId) {
          try {
            const conversation = await aiService.createConversation({ appId, conversationType });
            conversationId = conversation?.id;
            set(
              (state) => {
                state.currentConversationId = conversationId ?? null;
              },
              false,
              'aiBuilder/sendMessage/conversationCreated'
            );
          } catch (error) {
            set(
              (state) => {
                state.error = buildErrorMessage(error, 'Failed to start conversation');
                state.streamingMessage = null;
                state.isSending = false;
              },
              false,
              'aiBuilder/sendMessage/createConversationFailed'
            );
            return;
          }
        }

        const body = {
          appId,
          conversationType,
          conversationId,
          content: trimmedContent,
        };

        const onMessage = ({ data, type }) => {
          if (type === 'chunk') {
            set(
              (state) => {
                if (!state.streamingMessage) {
                  state.streamingMessage = { messageType: 'ai', content: '' };
                }
                state.streamingMessage.content += data?.content ?? '';
              },
              false,
              'aiBuilder/sendMessage/chunk'
            );
          } else if (type === 'done') {
            set(
              (state) => {
                if (data?.message) {
                  state.messages.push(data.message);
                  if (data.message.aiConversationId) {
                    state.currentConversationId = data.message.aiConversationId;
                  }
                }
                state.streamingMessage = null;
                state.isSending = false;
              },
              false,
              'aiBuilder/sendMessage/done'
            );
          } else if (type === 'error') {
            set(
              (state) => {
                state.error = data?.message || 'Something went wrong while generating a response';
                state.streamingMessage = null;
                state.isSending = false;
              },
              false,
              'aiBuilder/sendMessage/error'
            );
          }
        };

        try {
          await aiService.sendMessage(body, onMessage);
        } catch (error) {
          set(
            (state) => {
              state.error = buildErrorMessage(error, 'Failed to send message');
              state.streamingMessage = null;
              state.isSending = false;
            },
            false,
            'aiBuilder/sendMessage/catch'
          );
        }
      },
    })),
    {
      name: 'ai-builder-store',
      enabled: process.env.NODE_ENV !== 'production',
    }
  )
);

export default useAiBuilderStore;
