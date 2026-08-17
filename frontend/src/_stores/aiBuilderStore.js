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
  // Populated by the `plan` SSE event once approvePrd starts, then updated in place by
  // step-progress/step-done/step-failed as execution proceeds. Each entry:
  // { id, type, description, status: 'pending'|'running'|'succeeded'|'failed', artifact?, errorMessage? }
  steps: [],
  isApproving: false,
  // id of the step currently being rewound, or null — only one rewind can be in flight at
  // a time (rewindStep is a single synchronous backend call, not a stream).
  rewindingStepId: null,
  // { [messageId]: 'up' | 'down' } — which vote (if any) is currently recorded for a
  // message, so the chat panel can highlight the active vote button.
  votes: {},
  // id of the AI message currently being regenerated, or null.
  regeneratingMessageId: null,
  // Set synchronously (via useAiBuilderStore.setState, not the async actions below) by the
  // homepage-prompt handoff in useAppData.js, right before it opens the AI sidebar — tells
  // AiBuilderChatPanel's own mount bootstrap (listConversations -> loadConversation) to
  // stand down for that one mount, since the handoff is already populating this store via
  // createConversation/sendMessage. Without this, both fire for the same appId within a few
  // ms of each other, and loadConversation's unconditional overwrite of `messages`/
  // `streamingMessage` can wipe the in-flight prompt/reply the handoff just started (ADR-0010).
  skipConversationBootstrap: false,
  error: null,
};

const buildErrorMessage = (error, fallback) => error?.error || error?.data?.message || error?.message || fallback;

// Messages fetched from the backend carry their vote as a nested `aiResponseVote`
// relation (findLatestByConversationId's `relations: ['aiResponseVote', ...]`) — this
// flattens that into the `{ [messageId]: 'up' | 'down' }` map the chat panel reads to
// highlight the active vote button.
const extractVotes = (messages) =>
  (messages || []).reduce((votes, message) => {
    if (message?.aiResponseVote?.voteType) {
      votes[message.id] = message.aiResponseVote.voteType;
    }
    return votes;
  }, {});

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
            state.steps = [];
            state.isApproving = false;
            state.rewindingStepId = null;
            state.votes = {};
            state.regeneratingMessageId = null;
            state.skipConversationBootstrap = false;
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
              state.votes = extractVotes(state.messages);
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
              state.votes = extractVotes(state.messages);
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

      // Approves the current PRD and streams execution progress: `plan` seeds the step
      // list, `step-progress`/`step-done`/`step-failed` update one step in place by its
      // 1-based `step` index, and `done` carries a failure AiConversationMessage when
      // execution stopped early (already-succeeded steps' Artifacts stay as they are).
      approvePrd: async (prd) => {
        const conversationId = get().currentConversationId;
        if (!conversationId || !prd) return;

        set(
          (state) => {
            state.isApproving = true;
            state.steps = [];
            state.error = null;
          },
          false,
          'aiBuilder/approvePrd/start'
        );

        const onMessage = ({ data, type }) => {
          if (type === 'plan') {
            set(
              (state) => {
                state.steps = (data?.steps || []).map((step) => ({ ...step, status: 'pending' }));
              },
              false,
              'aiBuilder/approvePrd/plan'
            );
          } else if (type === 'step-progress') {
            set(
              (state) => {
                const step = state.steps[data.step - 1];
                if (step) step.status = 'running';
              },
              false,
              'aiBuilder/approvePrd/step-progress'
            );
          } else if (type === 'step-done') {
            set(
              (state) => {
                const step = state.steps[data.step - 1];
                if (step) {
                  step.status = 'succeeded';
                  step.artifact = data.artifact;
                }
              },
              false,
              'aiBuilder/approvePrd/step-done'
            );
          } else if (type === 'step-failed') {
            set(
              (state) => {
                const step = state.steps[data.step - 1];
                if (step) {
                  step.status = 'failed';
                  step.errorMessage = data.message;
                }
              },
              false,
              'aiBuilder/approvePrd/step-failed'
            );
          } else if (type === 'done') {
            set(
              (state) => {
                if (data?.message) state.messages.push(data.message);
                state.isApproving = false;
              },
              false,
              'aiBuilder/approvePrd/done'
            );
          } else if (type === 'error') {
            set(
              (state) => {
                state.error = data?.message || 'Failed to build the plan';
                state.isApproving = false;
              },
              false,
              'aiBuilder/approvePrd/error'
            );
          }
        };

        try {
          await aiService.approvePrd({ conversationId, prd }, onMessage);
        } catch (error) {
          set(
            (state) => {
              state.error = buildErrorMessage(error, 'Failed to approve the plan');
              state.isApproving = false;
            },
            false,
            'aiBuilder/approvePrd/catch'
          );
        }
      },

      // Rewinds the plan back to `stepId` (a completed step): the backend discards every
      // step after it (ADR-0008), so `state.steps` is trimmed to match — everything from
      // the rewound-to step's index onward, keeping only steps up to and including it.
      rewindStep: async (stepId) => {
        const conversationId = get().currentConversationId;
        if (!conversationId || !stepId) return;

        set(
          (state) => {
            state.rewindingStepId = stepId;
            state.error = null;
          },
          false,
          'aiBuilder/rewindStep/start'
        );

        try {
          const result = await aiService.rewindStep({ conversationId, stepId });
          set(
            (state) => {
              const undoneIds = new Set(result?.undone || []);
              state.steps = state.steps.filter((step) => !undoneIds.has(step.id));
              state.rewindingStepId = null;
            },
            false,
            'aiBuilder/rewindStep/success'
          );
          return result;
        } catch (error) {
          set(
            (state) => {
              state.error = buildErrorMessage(error, 'Failed to rewind');
              state.rewindingStepId = null;
            },
            false,
            'aiBuilder/rewindStep/error'
          );
          return null;
        }
      },

      // Upserts the vote for `messageId` (ADR-0009: one vote row per message). Optimistic —
      // the button's highlighted state flips immediately rather than waiting on the round
      // trip, since a vote failure isn't disruptive enough to warrant blocking the UI on it.
      voteMessage: async (messageId, voteType) => {
        if (!messageId || !voteType) return;

        const previousVote = get().votes[messageId];
        set(
          (state) => {
            state.votes[messageId] = voteType;
          },
          false,
          'aiBuilder/voteMessage/optimistic'
        );

        try {
          await aiService.voteMessage(messageId, voteType);
        } catch (error) {
          set(
            (state) => {
              if (previousVote) {
                state.votes[messageId] = previousVote;
              } else {
                delete state.votes[messageId];
              }
              state.error = buildErrorMessage(error, 'Failed to record vote');
            },
            false,
            'aiBuilder/voteMessage/error'
          );
        }
      },

      // Regenerates the AI reply to `parentMessageId` (ADR-0009: only the conversation's
      // current last turn can be regenerated). Replaces the stale reply in `state.messages`
      // with the new one in place, rather than appending — the stale reply is no longer
      // `isLatest` on the backend either.
      regenerateMessage: async (parentMessageId) => {
        if (!parentMessageId) return;

        set(
          (state) => {
            state.regeneratingMessageId = parentMessageId;
            state.error = null;
          },
          false,
          'aiBuilder/regenerateMessage/start'
        );

        try {
          const newMessage = await aiService.regenerateMessage({ parentMessageId });
          set(
            (state) => {
              const staleIndex = state.messages.findIndex(
                (message) => message.parentId === parentMessageId && message.messageType === 'ai'
              );
              if (staleIndex === -1) {
                state.messages.push(newMessage);
              } else {
                state.messages[staleIndex] = newMessage;
              }
              state.regeneratingMessageId = null;
            },
            false,
            'aiBuilder/regenerateMessage/success'
          );
          return newMessage;
        } catch (error) {
          set(
            (state) => {
              state.error = buildErrorMessage(error, 'Failed to regenerate the response');
              state.regeneratingMessageId = null;
            },
            false,
            'aiBuilder/regenerateMessage/error'
          );
          return null;
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
