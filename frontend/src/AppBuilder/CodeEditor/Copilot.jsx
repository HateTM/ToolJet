import React, { useCallback, useRef, useState } from 'react';
// eslint-disable-next-line import/no-unresolved
import * as RadixPopover from '@radix-ui/react-popover';
import { Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import useStore from '@/AppBuilder/_stores/store';
import { useModuleContext } from '@/AppBuilder/_contexts/ModuleContext';
import { useIsAiBlockedOnDefaultBranch } from '@/_hooks/useIsAiBlockedOnDefaultBranch';
import { aiService } from '@/_services/ai.service';
import { readAiServiceError } from '@/_helpers/aiServiceError';
import { Button } from '@/components/ui/Button/Button';
// The `Textarea` primitive rather than its `TextArea/Index` wrapper: the wrapper's
// `defaultProps.validation` is a truthy no-op that returns undefined, which its own onChange
// then dereferences — it throws on the first keystroke, and nothing else in the app uses it.
import { Textarea } from '@/components/ui/TextArea/Textarea';

/**
 * Reads what is currently in the editor, straight off the CodeMirror view.
 *
 * This is why `editorRef` is in the `renderCopilot` payload at all: the slot is handed no
 * value prop, and `MultiLineCodeEditor`'s own `currentValueRef` is not exposed. Reading the
 * live doc also means a completion is grounded in what the user can see right now, rather
 * than in whatever had been committed by the last `onChange`.
 */
const readEditorCode = (editorRef) => {
  try {
    return editorRef?.current?.view?.state?.doc?.toString() ?? '';
  } catch {
    return '';
  }
};

/**
 * The editor languages a `Completion` can actually be written for.
 *
 * `renderCopilot` is threaded to every multi-line code field a plugin's `DynamicForm` declares,
 * which includes SQL editors for `postgresql` and friends — but the prompt behind this feature
 * describes the JS/Python query runtime (`queries.<name>.run()`, an explicit `return`), so a
 * completion for a SQL field would be JavaScript in a SQL box. Rather than widen the prompt,
 * the affordance simply does not appear where it cannot answer well (ADR-0015).
 */
const SUPPORTED_LANGUAGES = ['javascript', 'python'];

/**
 * The `Copilot` affordance (CONTEXT.md): a button in the query editor's overlay controls that
 * opens a prompt, and writes the `Completion` it gets back over the whole editor body.
 *
 * Rendered into `MultiLineCodeEditor`'s `copilotBtnSlot`, which is the trigger this feature
 * was scoped around — nothing here listens for keystrokes and no request is made that the
 * user did not click for (ADR-0015).
 *
 * State is local rather than a store slice, unlike `Fix with AI`: there the fetch is driven by
 * PreviewBox, which is upstream code this fork would rather not fork, so the two had to meet
 * in the store. Here this component owns the whole interaction, and one popover's pending
 * request is of no interest to anything else in the app.
 */
function Copilot({ darkMode, language, editorRef, onAiSuggestionAccept, selectedDataSource }) {
  const { t } = useTranslation();
  const { moduleId = 'canvas' } = useModuleContext() ?? {};

  const aiFeaturesEnabled = useStore((state) => state.ai?.aiFeaturesEnabled ?? false);
  // The `state.appId ?? appStore.modules[...]` pair the rest of the editor reads (see
  // CreateVersionModal, EditVersionModal): without the first branch this silently resolves to
  // undefined in some editor contexts, and an undefined appId costs the completion its
  // App inventory without saying so.
  const appId = useStore((state) => state.appId ?? state.appStore?.modules?.[moduleId]?.app?.appId);
  const isAiBlockedByBranch = useIsAiBlockedOnDefaultBranch();

  const [isOpen, setIsOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('idle');
  const [completion, setCompletion] = useState(null);
  const [error, setError] = useState(null);

  // Guards against a slow response from an earlier ask overwriting a newer one — the user can
  // hit Try again while a request is still in flight, and the popover must end up showing the
  // completion for the ask they made last, not the one that happened to land last.
  const requestIdRef = useRef(0);

  const submit = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return;

    const requestId = ++requestIdRef.current;
    setStatus('pending');
    setError(null);

    try {
      const result = await aiService.getCopilotSuggestion({
        prompt: trimmedPrompt,
        currentCode: readEditorCode(editorRef),
        language,
        dataSourceKind: selectedDataSource?.kind,
        appId,
      });

      if (requestId !== requestIdRef.current) return;
      setCompletion(result);
      setStatus('done');
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(readAiServiceError(err) ?? t('editor.copilot.genericError', 'Something went wrong. Please try again.'));
      setStatus('error');
    }
  }, [prompt, editorRef, language, selectedDataSource?.kind, appId, t]);

  const handleApply = () => {
    if (!completion?.code) return;
    onAiSuggestionAccept?.(completion.code);
    handleOpenChange(false);
  };

  /**
   * Closing keeps the prompt but drops the `Completion`. The prompt is the user's typing and
   * a mis-click outside shouldn't cost it; the completion was written against the editor's
   * contents at the time it was asked for, which may well have moved on by the next open —
   * showing it again would offer an Apply that silently reverts whatever was typed since.
   */
  const handleOpenChange = (open) => {
    setIsOpen(open);
    if (!open) {
      requestIdRef.current += 1; // any in-flight response is now stale
      setCompletion(null);
      setError(null);
      setStatus('idle');
    }
  };

  // Same gate as the `Fix with AI` trigger on a failing property (PreviewBox): AI has to be
  // licensed and reachable, and a branching workspace only allows it off the default branch.
  if (!aiFeaturesEnabled || isAiBlockedByBranch) return null;
  // ...plus one this feature adds: the editor has to be in a language a Completion can be
  // written for, which a plugin's SQL code field is not.
  if (!SUPPORTED_LANGUAGES.includes((language || '').trim().toLowerCase())) return null;

  const isPending = status === 'pending';

  return (
    <RadixPopover.Root open={isOpen} onOpenChange={handleOpenChange}>
      <RadixPopover.Trigger asChild>
        <Button
          iconOnly
          size="medium"
          variant="outline"
          aria-label={t('editor.copilot.title', 'Write with AI')}
          data-cy="copilot-trigger-button"
        >
          <Sparkles width="14" height="14" className="tw-text-icon-brand" />
        </Button>
      </RadixPopover.Trigger>

      <RadixPopover.Portal>
        <RadixPopover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className={`tw-z-[9999] tw-w-96 tw-rounded-lg tw-border tw-border-solid tw-border-border-default tw-bg-background-surface-layer-01 tw-shadow-lg ${
            darkMode ? 'dark-theme' : ''
          }`}
          data-cy="copilot-popover"
        >
          <div className="tw-flex tw-flex-col tw-gap-3 tw-p-3">
            <div className="tw-flex tw-items-center tw-justify-between tw-gap-2">
              <div className="tw-flex tw-items-center tw-gap-2">
                <Sparkles width="14" height="14" className="tw-text-icon-brand" />
                <span className="tw-font-title-default tw-text-text-default">
                  {t('editor.copilot.title', 'Write with AI')}
                </span>
              </div>

              <Button
                size="small"
                variant="ghost"
                iconOnly
                aria-label={t('editor.copilot.close', 'Close')}
                onClick={() => handleOpenChange(false)}
                data-cy="copilot-close-button"
              >
                <X width="14" height="14" />
              </Button>
            </div>

            <Textarea
              width="100%"
              value={prompt}
              disabled={isPending}
              aria-label={t('editor.copilot.promptLabel', 'Describe what this query should do')}
              placeholder={t('editor.copilot.placeholder', 'e.g. fetch the users and keep only the active ones')}
              onValueChange={(event) => setPrompt(event.target.value)}
              data-cy="copilot-prompt-input"
            />

            {status === 'idle' && (
              <div>
                <Button
                  size="medium"
                  variant="primary"
                  onClick={submit}
                  disabled={!prompt.trim()}
                  data-cy="copilot-generate-button"
                >
                  {t('editor.copilot.generate', 'Generate code')}
                </Button>
              </div>
            )}

            {isPending && (
              <p className="tw-mb-0 tw-font-body-default tw-text-text-placeholder" data-cy="copilot-pending">
                {t('editor.copilot.pending', 'Writing the code…')}
              </p>
            )}

            {status === 'error' && (
              <div className="tw-flex tw-flex-col tw-gap-2" data-cy="copilot-error">
                <p className="tw-mb-0 tw-font-body-default tw-text-text-danger">{error}</p>
                <div>
                  <Button size="medium" variant="outline" onClick={submit} data-cy="copilot-retry-button">
                    {t('editor.copilot.retry', 'Try again')}
                  </Button>
                </div>
              </div>
            )}

            {status === 'done' && (
              <div className="tw-flex tw-flex-col tw-gap-3" data-cy="copilot-completion">
                <p className="tw-mb-0 tw-font-body-default tw-text-text-default">{completion?.explanation}</p>

                {/* Shown verbatim because this is exactly what Apply writes over the editor —
                    the review step is the only thing standing between a generated body and
                    the user's existing code (ADR-0016), so it must not be abridged. */}
                <pre className="tw-mb-0 tw-max-h-60 tw-overflow-auto tw-whitespace-pre-wrap tw-break-words tw-rounded-md tw-border tw-border-solid tw-border-border-default tw-bg-background-surface-layer-02 tw-p-2 tw-font-body-small tw-text-text-default">
                  {completion?.code}
                </pre>

                <div className="tw-flex tw-items-center tw-gap-2">
                  <Button
                    size="medium"
                    variant="primary"
                    onClick={handleApply}
                    disabled={!completion?.code}
                    data-cy="copilot-apply-button"
                  >
                    {t('editor.copilot.apply', 'Replace editor contents')}
                  </Button>
                  <Button size="medium" variant="outline" onClick={submit} data-cy="copilot-retry-button">
                    {t('editor.copilot.retry', 'Try again')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export default Copilot;
