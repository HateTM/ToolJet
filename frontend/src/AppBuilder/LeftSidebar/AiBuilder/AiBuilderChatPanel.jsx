import React, { useEffect, useRef, useState } from 'react';
import cx from 'classnames';
import { shallow } from 'zustand/shallow';
import { useTranslation } from 'react-i18next';
import {
  History,
  Plus,
  X,
  ArrowUp,
  Check,
  Circle,
  RotateCcw,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  Hammer,
} from 'lucide-react';
import { Button } from '@/components/ui/Button/Button';
import Spinner from '@/_ui/Spinner';
import useAiBuilderStore from '@/_stores/aiBuilderStore';

const tAiBuilder = (t, key, fallback) => t(`leftSidebar.AI Builder.${key}`, fallback);

const ConversationHistory = ({ conversations, onSelect, onClose }) => {
  const { t } = useTranslation();
  return (
    <div className="tw-absolute tw-right-3 tw-top-12 tw-z-10 tw-w-64 tw-max-h-72 tw-overflow-y-auto tw-rounded-md tw-border tw-border-border-weak tw-bg-background-surface-layer-01 tw-shadow-lg">
      {conversations.length === 0 ? (
        <div className="tw-p-3 tw-text-sm tw-text-text-placeholder">
          {tAiBuilder(t, 'noConversations', 'No previous conversations yet')}
        </div>
      ) : (
        conversations.map((conversation) => (
          <button
            key={conversation.id}
            type="button"
            className="tw-block tw-w-full tw-truncate tw-border-none tw-bg-transparent tw-px-3 tw-py-2 tw-text-left tw-text-sm tw-text-text-default hover:tw-bg-interactive-hover"
            onClick={() => {
              onSelect(conversation.id);
              onClose();
            }}
          >
            {conversation.title ||
              conversation.messages?.[0]?.content ||
              tAiBuilder(t, 'untitledConversation', 'Untitled conversation')}
          </button>
        ))
      )}
    </div>
  );
};

// The two kinds of thread the panel can be on. `learn` answers questions about the app from a
// freshly-assembled App inventory and never builds; `generate` is the PRD → approve → build
// cycle. A conversation's type is fixed for its whole life on the backend (ADR-0012), so this
// selector switches which thread the panel is showing — it never converts the current one.
const CONVERSATION_MODES = [
  { type: 'generate', labelKey: 'modeBuild', labelFallback: 'Build' },
  { type: 'learn', labelKey: 'modeLearn', labelFallback: 'Learn' },
];

const ConversationModeSelector = ({ conversationType, onChange, disabled }) => {
  const { t } = useTranslation();
  return (
    <div
      className="tw-flex tw-items-center tw-gap-0.5 tw-rounded-md tw-bg-background-surface-layer-02 tw-p-0.5"
      role="radiogroup"
      aria-label={tAiBuilder(t, 'conversationMode', 'Conversation mode')}
      data-cy="ai-builder-mode-selector"
    >
      {CONVERSATION_MODES.map((mode) => (
        <button
          key={mode.type}
          type="button"
          role="radio"
          aria-checked={conversationType === mode.type}
          disabled={disabled}
          className={cx('tw-rounded tw-border-none tw-px-2 tw-py-0.5 tw-text-xs disabled:tw-opacity-50', {
            'tw-bg-background-surface-layer-01 tw-text-text-default': conversationType === mode.type,
            'tw-bg-transparent tw-text-text-placeholder': conversationType !== mode.type,
          })}
          onClick={() => onChange(mode.type)}
          data-cy={`ai-builder-mode-${mode.type}`}
        >
          {tAiBuilder(t, mode.labelKey, mode.labelFallback)}
        </button>
      ))}
    </div>
  );
};

// Vote/regenerate controls only apply to persisted AI messages (message.id set — excludes
// the in-flight streamingMessage buffer). `canRegenerate` is passed in rather than derived
// here since it depends on this being the conversation's last AI message (ADR-0009: only
// the current last turn can be regenerated) — a whole-list fact this single bubble can't see.
// `onPromote` is only supplied in a Learn conversation: it's how the user gets from an answer
// into building (ADR-0012), and it has no meaning in a thread that already builds.
const ChatBubble = ({ message, vote, onVote, canRegenerate, onRegenerate, isRegenerating, onPromote, isPromoting }) => {
  const { t } = useTranslation();
  const isPersistedAiMessage = message.messageType !== 'user' && Boolean(message.id);

  return (
    <div
      className={cx('tw-flex tw-flex-col tw-gap-1', {
        'tw-items-end': message.messageType === 'user',
        'tw-items-start': message.messageType !== 'user',
      })}
    >
      <div
        className={cx('tw-max-w-[85%] tw-rounded-lg tw-px-3 tw-py-2 tw-text-sm tw-whitespace-pre-wrap', {
          'tw-bg-button-primary tw-text-text-on-solid': message.messageType === 'user',
          'tw-bg-background-surface-layer-02 tw-text-text-default': message.messageType !== 'user',
        })}
      >
        {message.content}
      </div>
      {isPersistedAiMessage && (
        <div className="tw-flex tw-items-center tw-gap-0.5 tw-px-1">
          <button
            type="button"
            className={cx(
              'tw-flex tw-items-center tw-border-none tw-bg-transparent tw-p-0.5 hover:tw-text-icon-default',
              {
                'tw-text-icon-success': vote === 'up',
                'tw-text-icon-weak': vote !== 'up',
              }
            )}
            onClick={() => onVote(message.id, 'up')}
            aria-label={tAiBuilder(t, 'voteUp', 'Good response')}
            title={tAiBuilder(t, 'voteUp', 'Good response')}
            data-cy="ai-builder-vote-up-button"
          >
            <ThumbsUp width="12" height="12" />
          </button>
          <button
            type="button"
            className={cx(
              'tw-flex tw-items-center tw-border-none tw-bg-transparent tw-p-0.5 hover:tw-text-icon-default',
              {
                'tw-text-icon-danger': vote === 'down',
                'tw-text-icon-weak': vote !== 'down',
              }
            )}
            onClick={() => onVote(message.id, 'down')}
            aria-label={tAiBuilder(t, 'voteDown', 'Bad response')}
            title={tAiBuilder(t, 'voteDown', 'Bad response')}
            data-cy="ai-builder-vote-down-button"
          >
            <ThumbsDown width="12" height="12" />
          </button>
          {canRegenerate && (
            <button
              type="button"
              className="tw-flex tw-items-center tw-border-none tw-bg-transparent tw-p-0.5 tw-text-icon-weak hover:tw-text-icon-default disabled:tw-opacity-50"
              onClick={() => onRegenerate(message.parentId)}
              disabled={isRegenerating}
              aria-label={tAiBuilder(t, 'regenerate', 'Regenerate response')}
              title={tAiBuilder(t, 'regenerate', 'Regenerate response')}
              data-cy="ai-builder-regenerate-button"
            >
              {isRegenerating ? <Spinner size="small" /> : <RefreshCw width="12" height="12" />}
            </button>
          )}
          {onPromote && (
            <button
              type="button"
              className="tw-flex tw-items-center tw-gap-1 tw-border-none tw-bg-transparent tw-p-0.5 tw-text-xs tw-text-text-placeholder hover:tw-text-text-default disabled:tw-opacity-50"
              onClick={() => onPromote(message.id)}
              disabled={isPromoting}
              title={tAiBuilder(t, 'promoteHint', 'Start a build conversation from this answer')}
              data-cy="ai-builder-promote-button"
            >
              {isPromoting ? <Spinner size="small" /> : <Hammer width="12" height="12" />}
              <span>{tAiBuilder(t, 'promote', 'Start building')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// The zero state's greeting and suggestions are build prompts ("Build an inventory tracker…"),
// which would be actively misleading in a Learn conversation — it can't build any of them. So
// Learn gets its own static empty state and no suggestions, rather than reusing them.
const ZeroState = ({ zeroState, isZeroStateLoading, onSuggestionClick, isLearnMode }) => {
  const { t } = useTranslation();
  if (isZeroStateLoading) {
    return (
      <div className="tw-flex tw-flex-1 tw-items-center tw-justify-center">
        <Spinner />
      </div>
    );
  }
  if (isLearnMode) {
    return (
      <div className="tw-flex tw-flex-1 tw-flex-col tw-justify-center tw-gap-1 tw-px-4 tw-text-center">
        <p className="tw-text-base tw-font-medium tw-text-text-default">
          {tAiBuilder(t, 'learnGreeting', 'Ask anything about this app')}
        </p>
        <p className="tw-text-sm tw-text-text-placeholder">
          {tAiBuilder(
            t,
            'learnDescription',
            'I can explain its pages, components, data sources, queries, and what has already been built. I cannot change the app here.'
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="tw-flex tw-flex-1 tw-flex-col tw-justify-center tw-gap-4 tw-px-4 tw-text-center">
      <div>
        <p className="tw-text-base tw-font-medium tw-text-text-default">
          {zeroState?.user?.greeting || tAiBuilder(t, 'defaultGreeting', 'What would you like to build today?')}
        </p>
        {zeroState?.user?.description && (
          <p className="tw-mt-1 tw-text-sm tw-text-text-placeholder">{zeroState.user.description}</p>
        )}
      </div>
      {zeroState?.suggestions?.length > 0 && (
        <div className="tw-flex tw-flex-col tw-gap-2">
          {zeroState.suggestions.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              className="tw-rounded-md tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-px-3 tw-py-2 tw-text-left tw-text-sm tw-text-text-default hover:tw-bg-interactive-hover"
              onClick={() => onSuggestionClick(suggestion.action)}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const StepStatusIcon = ({ status }) => {
  if (status === 'running') return <Spinner size="small" />;
  if (status === 'succeeded') return <Check width="14" height="14" className="tw-text-icon-success" />;
  if (status === 'failed') return <X width="14" height="14" className="tw-text-icon-danger" />;
  return <Circle width="10" height="10" className="tw-text-icon-weak" />;
};

const StepProgressList = ({ steps, onRewind, rewindingStepId }) => {
  const { t } = useTranslation();
  return (
    <div className="tw-flex tw-flex-col tw-gap-2 tw-border-0 tw-border-b tw-border-solid tw-border-border-weak tw-px-3 tw-py-3">
      {steps.map((step, index) => (
        <div key={step.id ?? index} className="tw-flex tw-items-start tw-gap-2 tw-text-sm">
          <div className="tw-mt-0.5 tw-flex tw-w-4 tw-flex-shrink-0 tw-items-center tw-justify-center">
            <StepStatusIcon status={step.status} />
          </div>
          <div className="tw-flex tw-flex-1 tw-flex-col">
            <span className="tw-text-text-default">{step.description}</span>
            {step.status === 'failed' && step.errorMessage && (
              <span className="tw-text-xs tw-text-text-danger">{step.errorMessage}</span>
            )}
          </div>
          {step.status === 'succeeded' && step.id && (
            <button
              type="button"
              className="tw-flex tw-flex-shrink-0 tw-items-center tw-border-none tw-bg-transparent tw-p-0.5 tw-text-icon-weak hover:tw-text-icon-default disabled:tw-opacity-50"
              onClick={() => onRewind(step.id)}
              disabled={Boolean(rewindingStepId)}
              aria-label={t('leftSidebar.AI Builder.rewindToStep', 'Rewind to this step')}
              title={t('leftSidebar.AI Builder.rewindToStep', 'Rewind to this step')}
              data-cy={`ai-builder-rewind-step-${index}`}
            >
              {rewindingStepId === step.id ? <Spinner size="small" /> : <RotateCcw width="14" height="14" />}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};

// Matches BaseLeftSidebar's `renderAIChat({ darkMode, onClose })` contract (see LeftSidebar.jsx's
// renderPopoverContent 'tooljetai' case). `appId` is bound by the caller (AppBuilder.jsx), which
// is why it isn't part of that render-prop signature. The conversation type isn't a prop: it's
// user-switchable from the header's mode selector, and lives in the store so the actions that
// depend on it (which endpoint a message goes to, which threads are listed) read one source.
export const AiBuilderChatPanel = ({ darkMode, onClose, appId }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const messagesEndRef = useRef(null);

  const [
    messages,
    streamingMessage,
    isSending,
    zeroState,
    isZeroStateLoading,
    conversations,
    conversationType,
    steps,
    isApproving,
    rewindingStepId,
    votes,
    regeneratingMessageId,
    promotingMessageId,
    error,
    fetchZeroState,
    listConversations,
    loadConversation,
    resetConversation,
    setConversationType,
    sendMessage,
    approvePrd,
    rewindStep,
    voteMessage,
    regenerateMessage,
    promoteConversation,
    clearError,
  ] = useAiBuilderStore(
    (state) => [
      state.messages,
      state.streamingMessage,
      state.isSending,
      state.zeroState,
      state.isZeroStateLoading,
      state.conversations,
      state.conversationType,
      state.steps,
      state.isApproving,
      state.rewindingStepId,
      state.votes,
      state.regeneratingMessageId,
      state.promotingMessageId,
      state.error,
      state.fetchZeroState,
      state.listConversations,
      state.loadConversation,
      state.resetConversation,
      state.setConversationType,
      state.sendMessage,
      state.approvePrd,
      state.rewindStep,
      state.voteMessage,
      state.regenerateMessage,
      state.promoteConversation,
      state.clearError,
    ],
    shallow
  );

  const isLearnMode = conversationType === 'learn';

  useEffect(() => {
    if (!appId) return;
    // ADR-0010: the homepage-prompt handoff (useAppData.js) sets this synchronously right
    // before it opens the sidebar — this mount is its very first render, so the flag is
    // already there. Consume it and skip this bootstrap: the handoff is already populating
    // the store via its own createConversation/sendMessage, and racing this panel's
    // listConversations/loadConversation against that would overwrite the in-flight prompt.
    if (useAiBuilderStore.getState().skipConversationBootstrap) {
      useAiBuilderStore.setState({ skipConversationBootstrap: false });
      return;
    }
    listConversations(appId, conversationType).then((existing) => {
      // Something already put us on a thread while the list was in flight — Promote is the
      // real case: it lands on a brand new Generate conversation and flips the mode, which
      // re-runs this effect. Loading "the active conversation" over it would throw away the
      // context seed the store is already showing.
      if (useAiBuilderStore.getState().currentConversationId) return;
      const active = existing?.find((conversation) => conversation.active) || existing?.[0];
      if (active) {
        loadConversation(active.id);
      } else if (conversationType !== 'learn') {
        // Learn's empty state is static (build suggestions don't apply to it), so there's
        // nothing to fetch.
        fetchZeroState();
      }
    });
    // Re-runs when switching apps or modes — a mode switch is a different set of threads
    // (conversationType is fixed per conversation), so it needs the same bootstrap a fresh
    // mount does. Not on every store update: this is bootstrap, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, conversationType]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamingMessage]);

  const handleSend = (content) => {
    const trimmed = (content ?? draft).trim();
    if (!trimmed || isSending) return;
    setDraft('');
    sendMessage({ appId, content: trimmed, conversationType });
  };

  const handleModeChange = (nextType) => {
    if (isSending || isApproving) return;
    setHistoryOpen(false);
    setDraft('');
    setConversationType(nextType);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    resetConversation();
    // Learn's empty state is static — nothing to fetch (see ZeroState).
    if (!isLearnMode) fetchZeroState();
  };

  const latestAiMessage = [...messages].reverse().find((message) => message.messageType !== 'user');
  // Nothing to approve until there's a PRD reply, and once a plan exists this conversation's
  // approval is already in flight or done — CONTEXT.md's "Approve" is one-way per PRD. Never
  // in a Learn conversation: it has no PRD to approve, and the backend refuses approvePrd on
  // one outright — this just keeps the control from being offered in the first place.
  const canApprove = !isLearnMode && Boolean(latestAiMessage) && !streamingMessage && !isSending && steps.length === 0;

  const handleApprove = () => {
    if (!latestAiMessage || isApproving) return;
    approvePrd(latestAiMessage.content);
  };

  const showZeroState = messages.length === 0 && !streamingMessage;

  return (
    <div
      className={cx('tw-relative tw-flex tw-h-[100vh] tw-w-[360px] tw-flex-col tw-bg-background-surface-layer-01', {
        'dark-theme': darkMode,
      })}
      data-cy="ai-builder-chat-panel"
    >
      <div className="tw-flex tw-items-center tw-justify-between tw-border-0 tw-border-b tw-border-solid tw-border-border-weak tw-px-3 tw-py-2.5">
        <div className="tw-flex tw-items-center tw-gap-2">
          <span className="tw-text-sm tw-font-medium tw-text-text-default">{tAiBuilder(t, 'text', 'AI Builder')}</span>
          <ConversationModeSelector
            conversationType={conversationType}
            onChange={handleModeChange}
            disabled={isSending || isApproving}
          />
        </div>
        <div className="tw-flex tw-items-center tw-gap-1">
          <Button
            iconOnly
            onClick={handleNewChat}
            variant="ghost"
            size="medium"
            aria-label={tAiBuilder(t, 'newConversation', 'New conversation')}
            data-cy="ai-builder-new-chat-button"
          >
            <Plus width="16" height="16" />
          </Button>
          <Button
            iconOnly
            onClick={() => setHistoryOpen((open) => !open)}
            variant="ghost"
            size="medium"
            aria-label={tAiBuilder(t, 'conversationHistory', 'Conversation history')}
            data-cy="ai-builder-history-button"
          >
            <History width="16" height="16" />
          </Button>
          {onClose && (
            <Button
              iconOnly
              onClick={onClose}
              variant="ghost"
              size="medium"
              aria-label={tAiBuilder(t, 'close', 'Close')}
              data-cy="ai-builder-close-button"
            >
              <X width="16" height="16" />
            </Button>
          )}
        </div>
        {historyOpen && (
          <ConversationHistory
            conversations={conversations}
            onSelect={loadConversation}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>

      {showZeroState ? (
        <ZeroState
          zeroState={zeroState}
          isZeroStateLoading={isZeroStateLoading}
          onSuggestionClick={handleSend}
          isLearnMode={isLearnMode}
        />
      ) : (
        <div className="tw-flex tw-flex-1 tw-flex-col tw-gap-2 tw-overflow-y-auto tw-px-3 tw-py-3">
          {messages.map((message) => (
            <ChatBubble
              key={message.id}
              message={message}
              vote={votes[message.id]}
              onVote={voteMessage}
              canRegenerate={message.id === latestAiMessage?.id}
              onRegenerate={regenerateMessage}
              isRegenerating={regeneratingMessageId === message.parentId}
              onPromote={isLearnMode ? promoteConversation : undefined}
              isPromoting={promotingMessageId === message.id}
            />
          ))}
          {streamingMessage && <ChatBubble message={streamingMessage} />}
          {canApprove && (
            <Button
              onClick={handleApprove}
              variant="primary"
              size="small"
              className="tw-self-start"
              disabled={isApproving}
              data-cy="ai-builder-approve-prd-button"
            >
              {isApproving ? <Spinner size="small" /> : tAiBuilder(t, 'approvePrd', 'Approve and build')}
            </Button>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Steps (and the rewind control on each) belong to an approved PRD's execution — a
          Learn conversation never produces one, so the whole strip stays out of that mode. */}
      {!isLearnMode && steps.length > 0 && (
        <StepProgressList steps={steps} onRewind={rewindStep} rewindingStepId={rewindingStepId} />
      )}

      {error && (
        <div className="tw-flex tw-items-center tw-justify-between tw-bg-background-error-weak tw-px-3 tw-py-2 tw-text-xs tw-text-text-danger">
          <span>{error}</span>
          <button type="button" className="tw-border-none tw-bg-transparent tw-text-text-danger" onClick={clearError}>
            <X width="14" height="14" />
          </button>
        </div>
      )}

      <div className="tw-flex tw-items-end tw-gap-2 tw-border-0 tw-border-t tw-border-solid tw-border-border-weak tw-p-3">
        <textarea
          className="tw-flex-1 tw-resize-none tw-rounded-md tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-px-2.5 tw-py-2 tw-text-sm tw-text-text-default focus:tw-outline-none"
          rows={2}
          placeholder={
            isLearnMode
              ? tAiBuilder(t, 'learnInputPlaceholder', 'Ask a question about this app...')
              : tAiBuilder(t, 'inputPlaceholder', 'Describe the app you want to build...')
          }
          value={draft}
          disabled={isSending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          data-cy="ai-builder-message-input"
        />
        <Button
          iconOnly
          onClick={() => handleSend()}
          variant="primary"
          size="medium"
          disabled={isSending || !draft.trim()}
          aria-label={tAiBuilder(t, 'send', 'Send')}
          data-cy="ai-builder-send-button"
        >
          {isSending ? <Spinner size="small" /> : <ArrowUp width="16" height="16" />}
        </Button>
      </div>
    </div>
  );
};

export default AiBuilderChatPanel;
