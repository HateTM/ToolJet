import React, { useEffect, useRef, useState } from 'react';
import cx from 'classnames';
import { shallow } from 'zustand/shallow';
import { useTranslation } from 'react-i18next';
import { History, Plus, X, ArrowUp, Check, Circle, RotateCcw } from 'lucide-react';
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

const ChatBubble = ({ message }) => (
  <div
    className={cx('tw-max-w-[85%] tw-rounded-lg tw-px-3 tw-py-2 tw-text-sm tw-whitespace-pre-wrap', {
      'tw-self-end tw-bg-button-primary tw-text-text-on-solid': message.messageType === 'user',
      'tw-self-start tw-bg-background-surface-layer-02 tw-text-text-default': message.messageType !== 'user',
    })}
  >
    {message.content}
  </div>
);

const ZeroState = ({ zeroState, isZeroStateLoading, onSuggestionClick }) => {
  const { t } = useTranslation();
  if (isZeroStateLoading) {
    return (
      <div className="tw-flex tw-flex-1 tw-items-center tw-justify-center">
        <Spinner />
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
// renderPopoverContent 'tooljetai' case). `appId`/`conversationType` are bound by the caller
// (AppBuilder.jsx), which is why they aren't part of that render-prop signature.
export const AiBuilderChatPanel = ({ darkMode, onClose, appId, conversationType = 'generate' }) => {
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
    steps,
    isApproving,
    rewindingStepId,
    error,
    fetchZeroState,
    listConversations,
    loadConversation,
    resetConversation,
    sendMessage,
    approvePrd,
    rewindStep,
    clearError,
  ] = useAiBuilderStore(
    (state) => [
      state.messages,
      state.streamingMessage,
      state.isSending,
      state.zeroState,
      state.isZeroStateLoading,
      state.conversations,
      state.steps,
      state.isApproving,
      state.rewindingStepId,
      state.error,
      state.fetchZeroState,
      state.listConversations,
      state.loadConversation,
      state.resetConversation,
      state.sendMessage,
      state.approvePrd,
      state.rewindStep,
      state.clearError,
    ],
    shallow
  );

  useEffect(() => {
    if (!appId) return;
    listConversations(appId, conversationType).then((existing) => {
      const active = existing?.find((conversation) => conversation.active) || existing?.[0];
      if (active) {
        loadConversation(active.id);
      } else {
        fetchZeroState();
      }
    });
    // Only re-run when switching apps — conversation/zero-state loading is a one-time
    // bootstrap for the panel, not something that should refire on every store update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamingMessage]);

  const handleSend = (content) => {
    const trimmed = (content ?? draft).trim();
    if (!trimmed || isSending) return;
    setDraft('');
    sendMessage({ appId, content: trimmed, conversationType });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewChat = () => {
    resetConversation();
    fetchZeroState();
  };

  const latestAiMessage = [...messages].reverse().find((message) => message.messageType !== 'user');
  // Nothing to approve until there's a PRD reply, and once a plan exists this conversation's
  // approval is already in flight or done — CONTEXT.md's "Approve" is one-way per PRD.
  const canApprove = Boolean(latestAiMessage) && !streamingMessage && !isSending && steps.length === 0;

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
        <span className="tw-text-sm tw-font-medium tw-text-text-default">{tAiBuilder(t, 'text', 'AI Builder')}</span>
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
        <ZeroState zeroState={zeroState} isZeroStateLoading={isZeroStateLoading} onSuggestionClick={handleSend} />
      ) : (
        <div className="tw-flex tw-flex-1 tw-flex-col tw-gap-2 tw-overflow-y-auto tw-px-3 tw-py-3">
          {messages.map((message) => (
            <ChatBubble key={message.id} message={message} />
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

      {steps.length > 0 && <StepProgressList steps={steps} onRewind={rewindStep} rewindingStepId={rewindingStepId} />}

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
          placeholder={tAiBuilder(t, 'inputPlaceholder', 'Describe the app you want to build...')}
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
