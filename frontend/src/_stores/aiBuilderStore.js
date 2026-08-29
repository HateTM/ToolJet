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
  // Which kind of thread the panel is currently on — 'generate' (build an app through the
  // PRD → approve → build cycle) or 'learn' (ask questions about the app). Fixed per
  // conversation on the backend (ADR-0012); here it's what the mode selector switches
  // between, and it decides both which conversations are listed and which endpoint a
  // message goes to.
  conversationType: 'generate',
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
  // The plan previewed but not yet approved (ticket #20): the preview-plan endpoint's steps,
  // each optionally carrying its CreateTable step's planned table definition. Rendered as a
  // structured schema preview; cleared when real execution starts (approvePrd's plan event),
  // when the PRD is refined (sendMessage), or explicitly (discardPendingPlan).
  pendingPlan: [],
  isPreviewing: false,
  // id of the step currently being rewound, or null — only one rewind can be in flight at
  // a time (rewindStep is a single synchronous backend call, not a stream).
  rewindingStepId: null,
  // { [messageId]: 'up' | 'down' } — which vote (if any) is currently recorded for a
  // message, so the chat panel can highlight the active vote button.
  votes: {},
  // id of the AI message currently being regenerated, or null.
  regeneratingMessageId: null,
  // id of the Learn answer currently being promoted into a Generate conversation, or null.
  promotingMessageId: null,
  // Where the homepage-prompt handoff has got to: 'idle' | 'pending' | 'succeeded' | 'failed'.
  // Moved to 'pending' synchronously (via beginHandoff, before the sidebar opens) by
  // useAppData.js, so AiBuilderChatPanel's mount bootstrap (listConversations ->
  // loadConversation) already sees it on its very first render and stands down: the handoff
  // is populating this store itself via createConversation/sendMessage, and racing the two
  // lets loadConversation's unconditional overwrite of `messages`/`streamingMessage` wipe the
  // in-flight prompt/reply (ADR-0010).
  //
  // A status rather than ADR-0010's original boolean because the panel needs to tell a handoff
  // that is still running from one that failed: on failure it must bootstrap after all, or the
  // panel sits empty for the rest of the session with nothing but an error banner (ADR-0017).
  handoffStatus: 'idle',
  // The prompt the handoff is delivering, held only until it lands. Kept on failure so the
  // panel can put it back in the composer instead of the user having to retype it (ADR-0017).
  handoffPrompt: null,
  // The app the handoff belongs to. ADR-0010's boolean was consumed by the first mount that
  // saw it, which is what kept it from leaking; a status has no such moment, and this store
  // is a module singleton that outlives any one app. Without this, a 'succeeded' handoff for
  // app A would still be telling the panel to stand down after an SPA switch to app B — so
  // B's threads would never load and A's conversation would sit there instead. Every read of
  // handoffStatus is therefore scoped to the app it was recorded for (ADR-0017).
  handoffAppId: null,
  // Cleared by whatever can replace it — a write that fails again, an explicit clearError, a
  // mode switch, a new chat — but deliberately NOT by the read actions (listConversations /
  // loadConversation / fetchZeroState). ADR-0017 made a failed handoff trigger the panel's
  // bootstrap as its fallback, and those reads used to null this on start: the fallback would
  // have wiped the very banner explaining why the prompt was handed back to the composer,
  // leaving the user with an unexplained draft. A background read is not an answer to a failed
  // write, so it no longer dismisses one.
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

      // Switches the panel between Generate and Learn. The current thread is dropped rather
      // than kept per-mode: a conversation belongs to exactly one type on the backend, so
      // "the conversation I'm on" has no meaning across a mode switch — the panel bootstraps
      // the other mode's thread list from scratch. A no-op when the mode is unchanged, so a
      // stray re-select can't wipe an in-flight thread.
      setConversationType: (conversationType) => {
        if (get().conversationType === conversationType) return;
        set(
          (state) => {
            state.conversationType = conversationType;
            state.currentConversationId = null;
            state.conversations = [];
            state.messages = [];
            state.streamingMessage = null;
            state.isSending = false;
            state.steps = [];
            state.isApproving = false;
            state.pendingPlan = [];
            state.isPreviewing = false;
            state.rewindingStepId = null;
            state.votes = {};
            state.regeneratingMessageId = null;
            state.promotingMessageId = null;
            // The handoff is cleared for the same reason everything above it is: this switch
            // throws away the very thread the handoff produced, so it no longer owns the
            // panel's bootstrap. Leaving it would keep the bootstrap gate below closed while
            // there is nothing left in the store to show — the other mode's thread list would
            // never load, and neither would this one on switching back (ADR-0017).
            state.handoffStatus = 'idle';
            state.handoffPrompt = null;
            state.handoffAppId = null;
            state.error = null;
          },
          false,
          'aiBuilder/setConversationType'
        );
      },

      resetConversation: () => {
        set(
          (state) => {
            state.currentConversationId = null;
            state.messages = [];
            state.streamingMessage = null;
            state.isSending = false;
            state.steps = [];
            state.isApproving = false;
            state.pendingPlan = [];
            state.isPreviewing = false;
            state.rewindingStepId = null;
            state.votes = {};
            state.regeneratingMessageId = null;
            state.promotingMessageId = null;
            // The handoff is deliberately left alone here, unlike in setConversationType.
            // This is "New chat", which starts an empty thread and fetches its own zero state
            // — it doesn't need the panel's bootstrap, and the bootstrap effect now watches
            // handoffStatus/handoffAppId, so clearing them would re-run it and reload the very
            // thread the user just cleared. Leaving a spent handoff in place is harmless: both
            // terminal states are scoped to handoffAppId, and 'failed' only ever *permits* a
            // bootstrap while its prompt has already been consumed (ADR-0017).
            state.error = null;
          },
          false,
          'aiBuilder/resetConversation'
        );
      },

      // ADR-0017. These three are the handoff's whole lifecycle, and they're deliberately
      // plain synchronous setters: useAppData.js has to move the status before the sidebar
      // mounts the panel, which rules out doing it from inside an async action.
      beginHandoff: (prompt, appId) => {
        set(
          (state) => {
            state.handoffStatus = 'pending';
            state.handoffPrompt = prompt;
            state.handoffAppId = appId ?? null;
          },
          false,
          'aiBuilder/beginHandoff'
        );
      },

      // The prompt is dropped here, not kept: it was delivered, and it's now the first message
      // in the thread. Leaving it would re-prefill the composer with what the user already sent.
      finishHandoff: () => {
        set(
          (state) => {
            state.handoffStatus = 'succeeded';
            state.handoffPrompt = null;
          },
          false,
          'aiBuilder/finishHandoff'
        );
      },

      failHandoff: () => {
        set(
          (state) => {
            state.handoffStatus = 'failed';
          },
          false,
          'aiBuilder/failHandoff'
        );
      },

      // Read-and-clear: the panel prefills its composer from this exactly once, so editing or
      // sending that draft isn't undone by the next render. The status survives — it's what
      // tells the panel's bootstrap effect that this mount still has to run after all.
      consumeHandoffPrompt: () => {
        const prompt = get().handoffPrompt;
        if (prompt === null) return null;
        set(
          (state) => {
            state.handoffPrompt = null;
          },
          false,
          'aiBuilder/consumeHandoffPrompt'
        );
        return prompt;
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

      listConversations: async (appId, conversationType = get().conversationType) => {
        set(
          (state) => {
            state.isLoadingConversations = true;
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
              state.pendingPlan = [];
              state.isPreviewing = false;
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
      createConversation: async ({
        appId,
        conversationType = get().conversationType,
        currentConversationId,
        handoff,
      } = {}) => {
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
      // Resolves to whether the message was actually delivered (ADR-0017). It never rejects —
      // the chat panel calls it as a fire-and-forget click handler — so callers that need to
      // know, like the homepage-prompt handoff deciding whether the prompt is safe to drop,
      // read this boolean instead of attaching a .catch().
      sendMessage: async ({ appId, content, conversationType = get().conversationType }) => {
        const trimmedContent = (content ?? '').trim();
        if (!trimmedContent) return false;

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
            // The preview belonged to the pre-refinement PRD; this message makes it stale.
            state.pendingPlan = [];
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
            return false;
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
          // A Learn message goes to the docs-message endpoint instead (its answer is grounded
          // in a freshly-assembled App inventory, not a PRD prompt) — same SSE events, so
          // everything above this line is shared between the two modes.
          await aiService.sendMessage(body, onMessage, conversationType === 'learn');
          // An `error` SSE event ends the request normally — the stream opened, then the
          // backend reported a failure mid-flight and onMessage recorded it. A resolved
          // promise therefore isn't proof of delivery; the error state set during this send
          // (cleared at its start, just above) is what settles it.
          return !get().error;
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
          return false;
        }
      },

      // Ticket #20: fetches (or reuses) the plan for the conversation's latest PRD without
      // executing anything, so the user can review a structured schema preview first.
      previewPlan: async () => {
        const conversationId = get().currentConversationId;
        if (!conversationId) return;

        set(
          (state) => {
            state.isPreviewing = true;
            state.error = null;
          },
          false,
          'aiBuilder/previewPlan/start'
        );

        try {
          const { steps } = await aiService.previewPlan({ conversationId });
          set(
            (state) => {
              state.pendingPlan = steps || [];
              state.isPreviewing = false;
            },
            false,
            'aiBuilder/previewPlan/success'
          );
        } catch (error) {
          set(
            (state) => {
              state.pendingPlan = [];
              state.isPreviewing = false;
              state.error = buildErrorMessage(error, 'Failed to build the plan preview');
            },
            false,
            'aiBuilder/previewPlan/catch'
          );
        }
      },

      // The "I want to make changes" path: the preview is dropped but the PRD (and the whole
      // conversation) is kept — the user tweaks it with a targeted follow-up message rather
      // than a full regenerate (ticket #20; contrast ADR-0009's regenerate-message).
      discardPendingPlan: () => {
        set(
          (state) => {
            state.pendingPlan = [];
          },
          false,
          'aiBuilder/discardPendingPlan'
        );
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
            state.pendingPlan = [];
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
                // Steps carry their planned table definition (ticket #20) — kept for rendering.
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

      // Promotes a Learn answer into building (ADR-0012): the backend creates a *new* Generate
      // conversation seeded with that question/answer and leaves the Learn one untouched, so
      // this switches the panel over to the new thread — mode included. The Learn conversation
      // stays listed under Learn and can be switched back to from the history menu.
      promoteConversation: async (messageId) => {
        const conversationId = get().currentConversationId;
        if (!conversationId || !messageId) return null;

        set(
          (state) => {
            state.promotingMessageId = messageId;
            state.error = null;
          },
          false,
          'aiBuilder/promoteConversation/start'
        );

        try {
          const conversation = await aiService.promoteConversation({ conversationId, messageId });
          set(
            (state) => {
              state.conversationType = 'generate';
              state.currentConversationId = conversation?.id ?? null;
              state.conversations = [];
              state.messages = conversation?.messages || [];
              state.votes = {};
              state.streamingMessage = null;
              state.steps = [];
              state.promotingMessageId = null;
            },
            false,
            'aiBuilder/promoteConversation/success'
          );
          return conversation;
        } catch (error) {
          set(
            (state) => {
              state.error = buildErrorMessage(error, 'Failed to start building from this answer');
              state.promotingMessageId = null;
            },
            false,
            'aiBuilder/promoteConversation/error'
          );
          return null;
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
