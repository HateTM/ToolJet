import React, { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { ArrowUp } from 'lucide-react';
import { Button } from '@/components/ui/Button/Button';
import Spinner from '@/_ui/Spinner';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';

// `createApp` is HomePage.jsx's own method (already threading a `prompt` param through to
// appsService.createApp and, on success, navigating into the new app with
// `state: { prompt }` — ADR-0010's handoff picks that up on the builder side via
// useAppData.js, so nothing else is needed here beyond calling it with the typed prompt.
const CreateAppWithPrompt = ({ createApp }) => {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    try {
      await createApp(`Untitled App: ${uuidv4()}`, undefined, trimmed);
    } finally {
      // Only reached on failure — a successful createApp navigates away, unmounting this.
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCreate();
    }
  };

  return (
    <div
      className="tw-mb-4 tw-flex tw-items-end tw-gap-2 tw-rounded-md tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-p-3"
      data-cy="create-app-with-prompt"
    >
      <textarea
        className="tw-flex-1 tw-resize-none tw-border-none tw-bg-transparent tw-text-sm tw-text-text-default focus:tw-outline-none"
        rows={1}
        placeholder={t('homePage.createAppWithPrompt.placeholder', 'Describe the app you want to build...')}
        value={prompt}
        disabled={isCreating}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        data-cy="create-app-with-prompt-input"
      />
      <Button
        iconOnly
        onClick={handleCreate}
        variant="primary"
        size="medium"
        disabled={isCreating || !prompt.trim()}
        aria-label={t('homePage.createAppWithPrompt.submit', 'Create app')}
        data-cy="create-app-with-prompt-submit-button"
      >
        {isCreating ? <Spinner size="small" /> : <ArrowUp width="16" height="16" />}
      </Button>
    </div>
  );
};

export default withEditionSpecificComponent(CreateAppWithPrompt, 'AiBuilder');
