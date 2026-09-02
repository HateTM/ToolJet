import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  SkipForward,
} from 'lucide-react';
import { Button } from '@/components/ui/Button/Button';
import Spinner from '@/_ui/Spinner';
import SchemaPreview from './SchemaPreview';
import useAiBuilderStore from '@/_stores/aiBuilderStore';
import { aiService } from '@/_services/ai.service';
import PromptEditor from '@/modules/AiBuilder/components/CreateAppWithPrompt/PromptEditor/PromptEditor';
import { useMentionCatalog } from './mentionCatalog';
import { mentionCompletion } from './mentionCompletion';

const tAiBuilder = (t, key, fallback) => t(`leftSidebar.AI Builder.${key}`, fallback);

// Cumulative LLM token spend of the current thread (conversation metadata). Fetches when the
// thread changes and refreshes as messages complete; hidden until there is anything to show.
const TokenUsageIndicator = () => {
  const conversationId = useAiBuilderStore((state) => state.currentConversationId);
  const messages = useAiBuilderStore((state) => state.messages);
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    if (!conversationId) {
      setUsage(null);
      return undefined;
    }
    let cancelled = false;
    aiService
      .getTokenUsage(conversationId)
      .then((data) => {
        if (!cancelled) setUsage(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId, messages?.length]);

  if (!usage?.totalTokens) return null;
  return (
    <div
      className="tw-px-3 tw-pt-1 tw-text-right tw-text-xxs tw-text-text-placeholder"
      data-cy="ai-builder-token-usage"
    >
      {usage.totalTokens.toLocaleString()} tokens
    </div>
  );
};

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
  const isNoData = message.metadata?.feasibility?.type === 'noData';

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
        {isNoData ? (
          <div className="tw-flex tw-flex-col tw-gap-2">
            <span>I don&apos;t have enough detail to build that. Here are a few ways to proceed:</span>
            <ul className="tw-list-disc tw-pl-4 tw-space-y-1">
              {message.metadata.feasibility.recommendations.map((recommendation, index) => (
                <li key={index}>{recommendation}</li>
              ))}
            </ul>
          </div>
        ) : (
          message.content
        )}
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

// Ticket #62: per-query seed report for a succeeded CreateTable step — what landed in the
// table (counts) and, when some rows failed, each failed row with its error. The report
// rides in the Artifact's content, produced by AgentsService.SeedTable.
const SeedReportSection = ({ seed }) => {
  const { t } = useTranslation();
  if (!seed || !seed.total) return null;

  return (
    <div className="tw-mt-1 tw-flex tw-flex-col tw-gap-0.5" data-cy="ai-builder-seed-report">
      <span className="tw-text-xs tw-text-text-placeholder">
        {t(
          'leftSidebar.AI Builder.seedReportCounts',
          'Sample data: {{inserted}} inserted, {{updated}} updated, {{failed}} failed',
          {
            inserted: seed.inserted ?? 0,
            updated: seed.updated ?? 0,
            failed: seed.failed ?? 0,
          }
        )}
      </span>
      {(seed.failures || []).map((failure) => (
        <span key={failure.row} className="tw-text-xs tw-text-text-danger">
          {t('leftSidebar.AI Builder.seedReportRowFailed', 'Row {{row}}: {{error}}', {
            row: failure.row,
            error: failure.error,
          })}
        </span>
      ))}
    </div>
  );
};

const StepStatusIcon = ({ status }) => {
  if (status === 'running') return <Spinner size="small" />;
  if (status === 'succeeded') return <Check width="14" height="14" className="tw-text-icon-success" />;
  if (status === 'failed') return <X width="14" height="14" className="tw-text-icon-danger" />;
  // Ticket #21: a skipped step produced no Artifact — distinct from both succeeded and failed.
  if (status === 'skipped') return <SkipForward width="14" height="14" className="tw-text-icon-weak" />;
  return <Circle width="10" height="10" className="tw-text-icon-weak" />;
};

// Groups the flat ordered step list (ticket #21) into consecutive runs sharing the same
// planner-assigned phase. Steps without a phase (plans generated before #21, or a planner
// that left it blank) fall into one trailing unnamed group rather than each getting their own.
const groupStepsByPhase = (steps) => {
  const groups = [];
  for (const step of steps) {
    const phase = step.phase || null;
    const last = groups[groups.length - 1];
    if (last && last.phase === phase) {
      last.steps.push(step);
    } else {
      groups.push({ phase, steps: [step] });
    }
  }
  return groups;
};

// A phase group's resolved-step count for the "N/M" header: skipped steps count as resolved
// (the user decided their outcome), only pending/running/failed ones don't.
const countResolvedSteps = (steps) =>
  steps.filter((step) => step.status === 'succeeded' || step.status === 'skipped').length;

// Ticket #15: when a plan has stopped on a failure, an explicit "Undo this build" action
// rests at the bottom of the strip — it reuses rewind's discard via the store's undoBuild
// and is only offered while there is something built to undo (a succeeded step) and the
// plan isn't executing.
// Exported for the ticket #15 undo-offer visibility tests; not part of the module surface otherwise.
export const StepProgressList = ({
  steps,
  onRewind,
  rewindingStepId,
  onSkip,
  skippable,
  skippingStepId,
  isExecuting,
  onUndoBuild,
  undoingBuild,
}) => {
  const { t } = useTranslation();
  const groups = groupStepsByPhase(steps);
  // Ticket #15: the undo offer rests only on a stopped plan that both failed somewhere and
  // built something before that — nothing to undo otherwise, and never while executing.
  const canUndoBuild =
    !isExecuting && steps.some((step) => step.status === 'failed') && steps.some((step) => step.status === 'succeeded');
  return (
    <div className="tw-flex tw-flex-col tw-gap-2 tw-border-0 tw-border-b tw-border-solid tw-border-border-weak tw-px-3 tw-py-3">
      {groups.map((group, groupIndex) => (
        <div key={group.phase ?? `phase-${groupIndex}`} className="tw-flex tw-flex-col tw-gap-1.5">
          {/* A named group gets its header even when it's the only one — a one-phase plan is
              still a plan the planner labeled, and its N/M progress is still useful. */}
          {(groups.length > 1 || group.phase) && (
            <div className="tw-flex tw-items-center tw-justify-between">
              <span className="tw-text-xs tw-font-medium tw-text-text-default">
                {group.phase || tAiBuilder(t, 'defaultPhaseName', 'Implementation steps')}
              </span>
              <span className="tw-text-xs tw-text-text-placeholder">
                {countResolvedSteps(group.steps)}/{group.steps.length}
              </span>
            </div>
          )}
          {group.steps.map((step) => {
            const stepIndex = steps.indexOf(step);
            return (
              <div key={step.id ?? stepIndex} className="tw-flex tw-items-start tw-gap-2 tw-text-sm">
                <div className="tw-mt-0.5 tw-flex tw-w-4 tw-flex-shrink-0 tw-items-center tw-justify-center">
                  <StepStatusIcon status={step.status} />
                </div>
                <div className="tw-flex tw-flex-1 tw-flex-col">
                  <span
                    className={cx('tw-text-text-default', {
                      'tw-text-text-placeholder tw-line-through': step.status === 'skipped',
                    })}
                  >
                    {step.description}
                  </span>
                  {step.status === 'failed' && step.errorMessage && (
                    <span className="tw-text-xs tw-text-text-danger">{step.errorMessage}</span>
                  )}
                  {step.status === 'succeeded' && step.artifact?.content?.seed && (
                    <SeedReportSection seed={step.artifact.content.seed} />
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
                    data-cy={`ai-builder-rewind-step-${stepIndex}`}
                  >
                    {rewindingStepId === step.id ? <Spinner size="small" /> : <RotateCcw width="14" height="14" />}
                  </button>
                )}
                {/* Ticket #21: skip the step that's executing now or still pending — the plan
                    continues to the next step without a post-hoc rewind. */}
                {skippable && (step.status === 'running' || step.status === 'pending') && step.id && (
                  <button
                    type="button"
                    className="tw-flex tw-flex-shrink-0 tw-items-center tw-border-none tw-bg-transparent tw-p-0.5 tw-text-icon-weak hover:tw-text-icon-default disabled:tw-opacity-50"
                    onClick={() => onSkip(step.id)}
                    disabled={Boolean(skippingStepId)}
                    aria-label={t('leftSidebar.AI Builder.skipStep', 'Skip this step')}
                    title={t('leftSidebar.AI Builder.skipStep', 'Skip this step')}
                    data-cy={`ai-builder-skip-step-${stepIndex}`}
                  >
                    {skippingStepId === step.id ? <Spinner size="small" /> : <SkipForward width="14" height="14" />}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {canUndoBuild && (
        <button
          type="button"
          className="tw-flex tw-items-center tw-gap-1 tw-self-start tw-rounded-md tw-border-none tw-bg-transparent tw-p-0.5 tw-text-xs tw-text-text-placeholder hover:tw-text-text-default disabled:tw-opacity-50"
          onClick={onUndoBuild}
          disabled={undoingBuild || Boolean(rewindingStepId)}
          aria-label={t('leftSidebar.AI Builder.undoBuild', 'Undo this build')}
          title={t('leftSidebar.AI Builder.undoBuildHint', 'Undo everything this build changed')}
          data-cy="ai-builder-undo-build-button"
        >
          {undoingBuild ? <Spinner size="small" /> : <RotateCcw width="12" height="12" />}
          <span>{tAiBuilder(t, 'undoBuild', 'Undo this build')}</span>
        </button>
      )}
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
  const editorViewRef = useRef(null);
  // @-mentions picked from the autocomplete since the last send (ticket #27). A ref, not
  // state: the mentions never render directly — they ride the next sendMessage call.
  const pendingMentionsRef = useRef([]);
  // Stable identities for the completion extension's callbacks (it reads these per keystroke).
  const catalog = useMentionCatalog();
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;

  const handleMentionSelect = (reference) => {
    const mentions = pendingMentionsRef.current;
    if (!mentions.some((mention) => mention.type === reference.type && mention.id === reference.id)) {
      mentions.push(reference);
    }
  };
  const mentionExtensions = useMemo(
    () => [mentionCompletion({ getCatalog: () => catalogRef.current, onMentionSelect: handleMentionSelect })],
    []
  );

  const [
    messages,
    streamingMessage,
    isSending,
    isGenerating,
    zeroState,
    isZeroStateLoading,
    conversations,
    conversationType,
    steps,
    isApproving,
    pendingPlan,
    isPreviewing,
    rewindingStepId,
    skippingStepId,
    undoingBuild,
    votes,
    regeneratingMessageId,
    promotingMessageId,
    error,
    handoffStatus,
    handoffAppId,
    consumeHandoffPrompt,
    fetchZeroState,
    listConversations,
    loadConversation,
    resetConversation,
    setConversationType,
    sendMessage,
    approvePrd,
    previewPlan,
    discardPendingPlan,
    rewindStep,
    skipStep,
    undoBuild,
    voteMessage,
    regenerateMessage,
    promoteConversation,
    clearError,
  ] = useAiBuilderStore(
    (state) => [
      state.messages,
      state.streamingMessage,
      state.isSending,
      state.isGenerating,
      state.zeroState,
      state.isZeroStateLoading,
      state.conversations,
      state.conversationType,
      state.steps,
      state.isApproving,
      state.pendingPlan,
      state.isPreviewing,
      state.rewindingStepId,
      state.skippingStepId,
      state.undoingBuild,
      state.votes,
      state.regeneratingMessageId,
      state.promotingMessageId,
      state.error,
      state.handoffStatus,
      state.handoffAppId,
      state.consumeHandoffPrompt,
      state.fetchZeroState,
      state.listConversations,
      state.loadConversation,
      state.resetConversation,
      state.setConversationType,
      state.sendMessage,
      state.approvePrd,
      state.previewPlan,
      state.discardPendingPlan,
      state.rewindStep,
      state.skipStep,
      state.undoBuild,
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
    // ADR-0010: the homepage-prompt handoff (useAppData.js) moves this to 'pending'
    // synchronously right before it opens the sidebar — this mount is its very first render,
    // so the status is already there. Stand down while it runs and once it lands: the handoff
    // populates the store via its own createConversation/sendMessage, and racing this panel's
    // listConversations/loadConversation against that would overwrite the in-flight prompt.
    //
    // ADR-0017: 'failed' deliberately falls through to the bootstrap below. The handoff put
    // nothing in the store, so skipping here too would leave this panel empty behind an error
    // banner for the rest of the session — the effect only re-runs on appId/conversationType
    // (and now handoffStatus) change. Bootstrapping instead shows whatever really does exist
    // server-side, including a conversation the handoff created before failing on the message.
    //
    // Scoped to handoffAppId: unlike ADR-0010's boolean, a status isn't consumed by the mount
    // that reads it, and this store outlives any one app — so a 'succeeded' handoff for the
    // app the user just came from must not stop the next app's threads from loading.
    const handoffOwnsThisApp = handoffAppId === appId;
    if (handoffOwnsThisApp && (handoffStatus === 'pending' || handoffStatus === 'succeeded')) return;
    const recoveringFromFailedHandoff = handoffOwnsThisApp && handoffStatus === 'failed';
    listConversations(appId, conversationType).then((existing) => {
      // Something already put us on a thread while the list was in flight — Promote is the
      // real case: it lands on a brand new Generate conversation and flips the mode, which
      // re-runs this effect. Loading "the active conversation" over it would throw away the
      // context seed the store is already showing.
      const alreadyOnAThread = useAiBuilderStore.getState().currentConversationId;
      if (alreadyOnAThread) {
        // Except when that thread is the wreckage of a failed handoff: createConversation
        // succeeded and only the message failed, so we're pointed at a real conversation whose
        // only local content is sendMessage's optimistic user bubble, which was never
        // confirmed. Re-read it so the panel shows what the server actually stored (ADR-0017).
        if (recoveringFromFailedHandoff) loadConversation(alreadyOnAThread);
        return;
      }
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
    // mount does. Also on handoffStatus, which is what turns the stood-down mount above into
    // a real bootstrap the moment a handoff fails. Not on every store update: this is
    // bootstrap, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, conversationType, handoffStatus, handoffAppId]);

  // ADR-0017: a failed handoff never delivered what the user typed on the homepage, and the
  // navigation state it came from is only cleared on success — so put it back in the composer
  // rather than making them retype it. Read-and-clear, so it can't clobber a later edit, and
  // scoped to the app it was typed for, so it can't land in a different app's composer.
  useEffect(() => {
    if (handoffStatus !== 'failed' || handoffAppId !== appId) return;
    const prompt = consumeHandoffPrompt();
    if (prompt) setDraft(prompt);
  }, [appId, handoffStatus, handoffAppId, consumeHandoffPrompt]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamingMessage]);

  const handleSend = (content) => {
    const text = content ?? draft;
    const trimmed = text.trim();
    if (!trimmed || isGenerating) return;
    // Only mentions still present in the message text ride the payload — a mention the
    // user typed and then deleted is no longer something they referenced. The name must
    // end at a word boundary, so a shorter earlier mention isn't matched by a longer
    // token the user typed afterwards (@Users vs @UsersTable).
    const mentionsMentioned = (name) =>
      new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(text);
    const references = pendingMentionsRef.current.filter((mention) => mentionsMentioned(mention.name));
    setDraft('');
    pendingMentionsRef.current = [];
    sendMessage({ appId, content: trimmed, conversationType, ...(references.length && { references }) });
  };

  const handleModeChange = (nextType) => {
    if (isGenerating) return;
    setHistoryOpen(false);
    setDraft('');
    pendingMentionsRef.current = [];
    setConversationType(nextType);
  };

  const handleNewChat = () => {
    resetConversation();
    pendingMentionsRef.current = [];
    // Learn's empty state is static — nothing to fetch (see ZeroState).
    if (!isLearnMode) fetchZeroState();
  };

  const latestAiMessage = [...messages].reverse().find((message) => message.messageType !== 'user');
  const isFeasibilityVerdict = ['infeasible', 'noData'].includes(latestAiMessage?.metadata?.feasibility?.type);
  // Nothing to approve until there's a PRD reply, and once a plan exists this conversation's
  // approval is already in flight or done — CONTEXT.md's "Approve" is one-way per PRD. Never
  // in a Learn conversation: it has no PRD to approve, and the backend refuses approvePrd on
  // one outright — this just keeps the control from being offered in the first place.
  // Ticket #61: feasibility verdicts (refusal / noData) are also not approvable.
  const canApprove =
    !isLearnMode &&
    Boolean(latestAiMessage) &&
    !streamingMessage &&
    !isGenerating &&
    steps.length === 0 &&
    !isFeasibilityVerdict;

  const handleApprove = () => {
    if (!latestAiMessage || isGenerating) return;
    approvePrd(latestAiMessage.content);
  };

  // Ticket #20: review the plan as a structured schema preview before anything executes.
  const handleReviewPlan = () => {
    if (!latestAiMessage || isPreviewing) return;
    previewPlan();
  };

  // The "I want to make changes" path: the preview is discarded (not the PRD — no full
  // regenerate) and the composer takes over for a targeted follow-up.
  const handleMakeChanges = () => {
    discardPendingPlan();
    editorViewRef.current?.focus();
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
            disabled={isGenerating}
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
          {canApprove && pendingPlan.length === 0 && (
            <Button
              onClick={handleReviewPlan}
              variant="primary"
              size="small"
              className="tw-self-start"
              disabled={isPreviewing}
              data-cy="ai-builder-review-plan-button"
            >
              {isPreviewing ? <Spinner size="small" /> : tAiBuilder(t, 'reviewPlan', 'Review build plan')}
            </Button>
          )}
          {canApprove && pendingPlan.length > 0 && (
            <div className="tw-flex tw-flex-col tw-gap-2">
              <SchemaPreview steps={pendingPlan} />
              <div className="tw-flex tw-gap-2">
                <Button
                  onClick={handleApprove}
                  variant="primary"
                  size="small"
                  disabled={isGenerating}
                  data-cy="ai-builder-approve-prd-button"
                >
                  {isApproving ? <Spinner size="small" /> : tAiBuilder(t, 'looksGoodRunIt', 'Looks good, run it')}
                </Button>
                <Button
                  onClick={handleMakeChanges}
                  variant="secondary"
                  size="small"
                  data-cy="ai-builder-make-changes-button"
                >
                  {tAiBuilder(t, 'makeChanges', 'I want to make changes')}
                </Button>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Steps (and the rewind control on each) belong to an approved PRD's execution — a
          Learn conversation never produces one, so the whole strip stays out of that mode.
          Skip (ticket #21) is only offered while the plan is actually executing. */}
      {!isLearnMode && steps.length > 0 && (
        <StepProgressList
          steps={steps}
          onRewind={rewindStep}
          rewindingStepId={rewindingStepId}
          onSkip={skipStep}
          skippable={isApproving}
          skippingStepId={skippingStepId}
          isExecuting={isApproving}
          onUndoBuild={undoBuild}
          undoingBuild={undoingBuild}
        />
      )}

      {error && (
        <div
          data-cy="ai-builder-error-banner"
          className="tw-flex tw-items-center tw-justify-between tw-bg-background-error-weak tw-px-3 tw-py-2 tw-text-xs tw-text-text-danger"
        >
          <span>{error}</span>
          <button type="button" className="tw-border-none tw-bg-transparent tw-text-text-danger" onClick={clearError}>
            <X width="14" height="14" />
          </button>
        </div>
      )}

      <TokenUsageIndicator />
      <div className="tw-flex tw-items-end tw-gap-2 tw-border-0 tw-border-t tw-border-solid tw-border-border-weak tw-p-3">
        {/* Ticket #27: the composer is the CodeMirror PromptEditor (same editor as the
            homepage prompt) extended with @-mention autocomplete over the app's
            pages/components/queries. The wrapper keeps the textarea-era data-cy so
            existing e2e selectors keep working. */}
        <div className="tw-min-w-0 tw-flex-1" data-cy="ai-builder-message-input">
          <PromptEditor
            value={draft}
            onChange={setDraft}
            onSubmit={() => handleSend()}
            disabled={isGenerating}
            placeholder={
              isLearnMode
                ? tAiBuilder(t, 'learnInputPlaceholder', 'Ask a question about this app...')
                : tAiBuilder(t, 'inputPlaceholder', 'Describe the app you want to build...')
            }
            extensions={mentionExtensions}
            onReady={(view) => {
              editorViewRef.current = view;
            }}
          />
        </div>
        <Button
          iconOnly
          onClick={() => handleSend()}
          variant="primary"
          size="medium"
          disabled={isGenerating || !draft.trim()}
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
