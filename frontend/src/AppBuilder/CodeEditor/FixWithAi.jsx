import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { shallow } from 'zustand/shallow';
import { useTranslation } from 'react-i18next';

import useStore from '@/AppBuilder/_stores/store';
import { selectFixEntry } from '@/AppBuilder/_stores/slices/fixWithAiSlice';
import { Button } from '@/components/ui/Button/Button';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';

/**
 * The `Fix with AI` popover (CONTEXT.md), mounted by PreviewBox over a property whose
 * expression failed to resolve. It renders whatever single entry the fixWithAi slice holds
 * for this field — pending, a `Suggestion`, or a failed request — and nothing else: the
 * request itself is kicked off by PreviewBox before this opens, and Retry is PreviewBox's
 * own `onRetry`, so this component never talks to the service directly.
 *
 * There is deliberately no message list or follow-up input. One request yields one
 * Suggestion, and the only moves from here are apply, retry, or dismiss (ADR-0014).
 */
function FixWithAi({ componentId, componentKey, onApplyFix, onRetry, onClose }) {
  const { t } = useTranslation();
  const entry = useStore((state) => selectFixEntry(state, componentId, componentKey), shallow);

  const status = entry?.status;
  const suggestion = entry?.suggestion;

  const handleApply = () => {
    if (!suggestion?.fixedValue) return;
    onApplyFix?.(suggestion.fixedValue);
    onClose?.();
  };

  return (
    <div className="tw-flex tw-flex-col tw-gap-3 tw-p-3">
      <div className="tw-flex tw-items-center tw-justify-between tw-gap-2">
        <div className="tw-flex tw-items-center tw-gap-2">
          <Sparkles width="14" height="14" className="tw-text-icon-brand" />
          <span className="tw-font-title-default tw-text-text-default">
            {t('editor.fixWithAi.title', 'Fix with AI')}
          </span>
        </div>

        <Button
          size="small"
          variant="ghost"
          iconOnly
          aria-label={t('editor.fixWithAi.close', 'Close')}
          onClick={() => onClose?.()}
          data-cy="fix-with-ai-close-button"
        >
          <X width="14" height="14" />
        </Button>
      </div>

      {status === 'pending' && (
        <p className="tw-mb-0 tw-font-body-default tw-text-text-placeholder" data-cy="fix-with-ai-pending">
          {t('editor.fixWithAi.pending', 'Looking at the error…')}
        </p>
      )}

      {status === 'error' && (
        <div className="tw-flex tw-flex-col tw-gap-2" data-cy="fix-with-ai-error">
          <p className="tw-mb-0 tw-font-body-default tw-text-text-danger">{entry.error}</p>
          <div>
            <Button size="medium" variant="outline" onClick={() => onRetry?.()} data-cy="fix-with-ai-retry-button">
              {t('editor.fixWithAi.retry', 'Try again')}
            </Button>
          </div>
        </div>
      )}

      {status === 'done' && (
        <div className="tw-flex tw-flex-col tw-gap-3" data-cy="fix-with-ai-suggestion">
          <p className="tw-mb-0 tw-font-body-default tw-text-text-default">{suggestion?.explanation}</p>

          {/* The suggestion is shown verbatim because that is exactly what Apply writes into
              the field — it can be long, so it scrolls rather than stretching the popover. */}
          <pre className="tw-mb-0 tw-max-h-40 tw-overflow-auto tw-whitespace-pre-wrap tw-break-words tw-rounded-md tw-border tw-border-solid tw-border-border-default tw-bg-background-surface-layer-02 tw-p-2 tw-font-body-small tw-text-text-default">
            {suggestion?.fixedValue}
          </pre>

          <div className="tw-flex tw-items-center tw-gap-2">
            <Button
              size="medium"
              variant="primary"
              onClick={handleApply}
              disabled={!suggestion?.fixedValue}
              data-cy="fix-with-ai-apply-button"
            >
              {t('editor.fixWithAi.apply', 'Apply fix')}
            </Button>
            <Button size="medium" variant="outline" onClick={() => onRetry?.()} data-cy="fix-with-ai-retry-button">
              {t('editor.fixWithAi.retry', 'Try again')}
            </Button>
          </div>
        </div>
      )}

      {/* No entry at all — PreviewBox opens this popover before the request starts, and skips
          the request entirely for a field with no componentId. Offering the retry is what
          keeps that case from being a header over empty space. */}
      {!status && (
        <div className="tw-flex tw-flex-col tw-gap-2" data-cy="fix-with-ai-idle">
          <p className="tw-mb-0 tw-font-body-default tw-text-text-placeholder">
            {t('editor.fixWithAi.idle', 'No suggestion yet for this field.')}
          </p>
          <div>
            <Button size="medium" variant="outline" onClick={() => onRetry?.()} data-cy="fix-with-ai-retry-button">
              {t('editor.fixWithAi.retry', 'Try again')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default withEditionSpecificComponent(FixWithAi, 'AiBuilder');
