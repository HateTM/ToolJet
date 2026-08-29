import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Bug, ListTodo, Truck, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button/Button';
import Spinner from '@/_ui/Spinner';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';

// `createApp` is HomePage.jsx's own method (already threading a `prompt` param through to
// appsService.createApp and, on success, navigating into the new app with
// `state: { prompt }` — ADR-0010's handoff picks that up on the builder side via
// useAppData.js, so nothing else is needed here beyond calling it with the typed prompt.
const ROTATING_EXAMPLES = [
  'Build an inventory management system for a manufacturing company',
  'Build a customer support ticketing system for SaaS startup',
  'Build a vendor onboarding portal for procurement department',
  'Build a compliance audit tracker for a finance company',
];

const EXAMPLE_CHIPS = [
  { label: 'Task manager', prompt: 'Build a task management app for a small team', Icon: ListTodo },
  { label: 'Software bug tracker', prompt: 'Build a software bug tracker for a SaaS startup', Icon: Bug },
  { label: 'Employee directory', prompt: 'Build an employee directory for a mid-size company', Icon: Users },
  {
    label: 'Vendor management portal',
    prompt: 'Build a vendor management portal for a procurement department',
    Icon: Truck,
  },
];

const ROTATION_INTERVAL_MS = 4000;

const CreateAppWithPrompt = ({ createApp, variant = 'appsList' }) => {
  const { t } = useTranslation();
  const isHomeVariant = variant === 'home';
  const [prompt, setPrompt] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [exampleIndex, setExampleIndex] = useState(0);
  const textareaRef = useRef(null);

  // Rotating Tab-to-accept placeholder (home variant only): cycles through example
  // prompts while the textarea is empty; the user's typed text freezes the rotation.
  useEffect(() => {
    if (!isHomeVariant || prompt) return undefined;
    const timer = setInterval(() => {
      setExampleIndex((index) => (index + 1) % ROTATING_EXAMPLES.length);
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isHomeVariant, prompt]);

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
    // Tab accepts the currently shown example when nothing has been typed yet.
    if (isHomeVariant && e.key === 'Tab' && !prompt.trim()) {
      e.preventDefault();
      setPrompt(ROTATING_EXAMPLES[exampleIndex]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCreate();
    }
  };

  return (
    <div className="tw-w-full" data-cy="create-app-with-prompt-wrapper">
      <div
        className="tw-flex tw-items-end tw-gap-2 tw-rounded-md tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-p-3"
        data-cy="create-app-with-prompt"
      >
        <textarea
          ref={textareaRef}
          className="tw-flex-1 tw-resize-none tw-border-none tw-bg-transparent tw-text-sm tw-text-text-default focus:tw-outline-none"
          rows={1}
          placeholder={
            isHomeVariant
              ? ROTATING_EXAMPLES[exampleIndex]
              : t('homePage.createAppWithPrompt.placeholder', 'Describe the app you want to build...')
          }
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
      {!isHomeVariant && (
        <div className="tw-mt-2 tw-flex tw-flex-wrap tw-items-center tw-gap-2" data-cy="example-prompts-row">
          <span className="tw-font-body-default tw-text-12 tw-text-text-placeholder">
            {t('homePage.createAppWithPrompt.tryTheseExamples', 'Try these examples to get started')}
          </span>
          {EXAMPLE_CHIPS.map(({ label, prompt: examplePrompt, Icon }) => (
            <button
              key={label}
              type="button"
              className="tw-flex tw-items-center tw-gap-1.5 tw-rounded-full tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-px-3 tw-py-1 tw-text-12 tw-text-text-default hover:tw-bg-background-surface-layer-02"
              onClick={() => setPrompt(examplePrompt)}
              data-cy={`example-prompt-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            >
              <Icon width="12" height="12" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default withEditionSpecificComponent(CreateAppWithPrompt, 'AiBuilder');
