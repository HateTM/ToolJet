import React, { useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Bug, Database, ListTodo, Truck, Users, X } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Button } from '@/components/ui/Button/Button';
import Spinner from '@/_ui/Spinner';
import { globalDatasourceService } from '@/_services';
import { getWorkspaceId } from '@/_helpers/utils';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';
import PromptEditor from './PromptEditor';

// `createApp` is HomePage.jsx's own method (already threading a `prompt` param through to
// appsService.createApp and, on success, navigating into the new app with
// `state: { prompt }` — ADR-0010's handoff picks that up on the builder side via
// useAppData.js, so nothing else is needed here beyond calling it with the typed prompt.
// Example prompt strings live in the translation files (en/ru); the English
// literals below are i18next fallbacks. Each constant is a factory taking `t`
// so the arrays re-resolve when the active language changes.
const ROTATING_EXAMPLES = (t) => [
  t(
    'homePage.createAppWithPrompt.rotatingExamples.inventoryManagement',
    'Build an inventory management system for a manufacturing company'
  ),
  t(
    'homePage.createAppWithPrompt.rotatingExamples.supportTicketing',
    'Build a customer support ticketing system for SaaS startup'
  ),
  t(
    'homePage.createAppWithPrompt.rotatingExamples.vendorOnboarding',
    'Build a vendor onboarding portal for procurement department'
  ),
  t(
    'homePage.createAppWithPrompt.rotatingExamples.complianceAudit',
    'Build a compliance audit tracker for a finance company'
  ),
];

const EXAMPLE_CHIPS = (t) => [
  {
    label: t('homePage.createAppWithPrompt.chips.taskManager.label', 'Task manager'),
    prompt: t('homePage.createAppWithPrompt.chips.taskManager.prompt', 'Build a task management app for a small team'),
    Icon: ListTodo,
  },
  {
    label: t('homePage.createAppWithPrompt.chips.bugTracker.label', 'Software bug tracker'),
    prompt: t(
      'homePage.createAppWithPrompt.chips.bugTracker.prompt',
      'Build a software bug tracker for a SaaS startup'
    ),
    Icon: Bug,
  },
  {
    label: t('homePage.createAppWithPrompt.chips.employeeDirectory.label', 'Employee directory'),
    prompt: t(
      'homePage.createAppWithPrompt.chips.employeeDirectory.prompt',
      'Build an employee directory for a mid-size company'
    ),
    Icon: Users,
  },
  {
    label: t('homePage.createAppWithPrompt.chips.vendorPortal.label', 'Vendor management portal'),
    prompt: t(
      'homePage.createAppWithPrompt.chips.vendorPortal.prompt',
      'Build a vendor management portal for a procurement department'
    ),
    Icon: Truck,
  },
];

// Home-variant dropdown (ticket #45): unlike the short appsList chips, each option
// carries a full paragraph-length prompt — mirrors the production "Example prompts"
// dropdown, whose options are complete requirement descriptions.
const EXAMPLE_DROPDOWN = (t) => [
  {
    label: t('homePage.createAppWithPrompt.dropdown.taskManager.label', 'Task manager'),
    prompt: t(
      'homePage.createAppWithPrompt.dropdown.taskManager.prompt',
      "I'm managing multiple projects and responsibilities simultaneously but currently tracking everything through scattered methods including sticky notes, email reminders, and various digital tools. I frequently lose track of important deadlines or discover urgent tasks buried in my disorganized system, creating stress and impacting my ability to deliver quality work on time. I need a personal task management system that organizes my work by project categories, allowing me to separate different initiatives, departmental responsibilities, and administrative tasks. The system should track deadlines for each task with clear visibility into what's due today, this week, and upcoming, helping me plan my daily schedule around the most time-sensitive commitments. Priority levels are essential since work often shifts between urgent requests and routine responsibilities, and I need to quickly identify which items require immediate attention versus those I can schedule for later. The database should store task details including project context, estimated effort, and completion notes to help me track progress and reference previous work when similar requests arise."
    ),
  },
  {
    label: t('homePage.createAppWithPrompt.dropdown.bugTracker.label', 'Software bug tracker'),
    prompt: t(
      'homePage.createAppWithPrompt.dropdown.bugTracker.prompt',
      'Our development team currently manages bug reports through email threads and spreadsheets, causing us to lose track of critical issues and struggle with resolution visibility. We need a centralized bug tracking system to streamline how we document, prioritize, and resolve software defects. The system should provide structured forms for logging bug reports with reproduction steps, affected environments, and severity classifications from critical production failures to minor UI issues. Each entry needs priority rankings and status tracking from discovery through resolution, giving our product manager clear pipeline visibility. Developers require filtering capabilities by assigned team member, severity level, and affected modules to focus on relevant work during sprint planning. We need a searchable database storing all bug details, reporter information, and resolution notes to build institutional knowledge for recurring issues. Basic reporting on bug discovery patterns and resolution times would help us identify problematic code areas and improve development quality.'
    ),
  },
  {
    label: t('homePage.createAppWithPrompt.dropdown.employeeDirectory.label', 'Employee directory'),
    prompt: t(
      'homePage.createAppWithPrompt.dropdown.employeeDirectory.prompt',
      'Our startup has scaled from twelve to forty-five employees in the past eight months, and our team is struggling to keep track of who handles what responsibilities across our expanding departments. We need a centralized employee directory that displays current staff contact information including email addresses, phone extensions, and Slack handles alongside their department assignments and specific job titles. The system should include robust search functionality allowing users to find colleagues by name, department, job function, or even project involvement, helping our remote and hybrid workforce navigate our growing organization structure. We need the database to store employee photos and brief role descriptions so new hires can quickly identify team members during video calls and understand reporting relationships without constantly asking for introductions. Basic filtering by office location and department would help coordinate in-person meetings and team events across our distributed workforce.'
    ),
  },
  {
    label: t('homePage.createAppWithPrompt.dropdown.vendorPortal.label', 'Vendor management portal'),
    prompt: t(
      'homePage.createAppWithPrompt.dropdown.vendorPortal.prompt',
      'Our company has expanded from working with eight suppliers to managing relationships with over thirty vendors across raw materials, equipment maintenance, and professional services, but we are still tracking everything through scattered spreadsheets and email folders. We frequently miss contract renewal deadlines, leading to unexpected price increases or service interruptions. We need a centralized vendor management system that stores comprehensive supplier contact information including primary and backup contacts, payment terms, and preferred communication methods. The system should track contract start and end dates with alerts for upcoming renewals. Our procurement team requires access to complete purchase order history for each vendor, including order dates, amounts, delivery performance, and payment status to identify spending patterns and evaluate vendor reliability. Search functionality by vendor name, product category, or contract status would help our growing team quickly locate supplier information during urgent procurement situations.'
    ),
  },
];

// Matches the production /home reference (2s rotation).
const ROTATION_INTERVAL_MS = 2000;

const ExamplePromptsDropdown = ({ onSelect, disabled }) => {
  const { t } = useTranslation();
  const exampleDropdown = EXAMPLE_DROPDOWN(t);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="tw-flex tw-h-[32px] tw-items-center tw-justify-between tw-gap-[12px] tw-rounded-lg tw-border-[1px] tw-border-solid tw-border-border-default tw-bg-background-surface-layer-01 tw-px-[12px] tw-py-[7px] tw-text-[12px]/[18px] tw-font-normal tw-text-text-placeholder hover:tw-border-border-strong focus:tw-outline-none disabled:tw-cursor-not-allowed"
          data-cy="example-prompts-dropdown"
        >
          {t('homePage.createAppWithPrompt.examplePrompts', 'Example prompts')}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--icon-default)" xmlns="http://www.w3.org/2000/svg">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M16.9908 10.7525C17.1951 10.4589 17.2562 10.0173 17.1456 9.63373C17.0351 9.25012 16.7746 9 16.4857 9H7.91433C7.62541 9 7.36498 9.25012 7.25441 9.63373C7.14384 10.0173 7.20498 10.4589 7.40926 10.7525L11.4424 16.5491C11.8608 17.1503 12.5392 17.1503 12.9576 16.5491L16.9908 10.7525Z"
            />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="tw-z-50 tw-max-w-[420px] tw-overflow-hidden tw-rounded-lg tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-p-1 tw-shadow-elevation-200-box-shadow"
        >
          {exampleDropdown.map(({ label, prompt }) => (
            <DropdownMenu.Item
              key={label}
              className="tw-cursor-pointer tw-rounded-md tw-px-3 tw-py-2 tw-text-12 tw-text-text-default tw-outline-none hover:tw-bg-background-surface-layer-02"
              onSelect={() => onSelect(prompt)}
              data-cy={`example-prompts-option-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
            >
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
};

// Datasource tagging (ticket #47): lets the user reference a workspace datasource while
// composing the prompt. The workspace list is fetched lazily on first open via the
// global-datasource listing (no app version exists yet on /home, so the app-scoped
// datasourceService.getAll is not usable here). Selection is tracked outside the prompt
// text and handed to createApp as `{ datasources, tables }` — matching the production
// PromptInput's taggedResources shape.
// data-cy slugs are load-bearing — the cypress/unit tests select options and tags by them.
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

const DatasourceReferencePicker = ({ selected, onToggle, disabled }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [datasources, setDatasources] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const openMenu = async () => {
    setOpen(true);
    if (loaded) return;
    try {
      const list = await globalDatasourceService.getAll(getWorkspaceId());
      setDatasources(list ?? []);
    } catch {
      setDatasources([]);
    } finally {
      setLoaded(true);
    }
  };

  return (
    <div className="tw-relative tw-shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={openMenu}
        className="tw-flex tw-h-7 tw-w-7 tw-items-center tw-justify-center tw-rounded-md tw-text-icon-default hover:tw-bg-background-surface-layer-02 focus:tw-outline-none disabled:tw-cursor-not-allowed disabled:tw-opacity-50"
        aria-label={t('homePage.createAppWithPrompt.referenceDatasource', 'Reference a datasource')}
        data-cy="datasource-reference-button"
      >
        <Database width="16" height="16" />
      </button>
      {open && (
        <>
          {/* Invisible full-screen layer to catch outside clicks and close the menu */}
          <div className="tw-fixed tw-inset-0 tw-z-40" onClick={() => setOpen(false)} />
          <div
            className="tw-absolute tw-bottom-9 tw-left-0 tw-z-50 tw-max-h-[240px] tw-min-w-[200px] tw-overflow-y-auto tw-rounded-lg tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-p-1 tw-shadow-elevation-200-box-shadow"
            data-cy="datasource-reference-menu"
          >
            {datasources.length === 0 ? (
              <div className="tw-px-3 tw-py-2 tw-text-12 tw-text-text-placeholder" data-cy="datasource-reference-empty">
                {t('homePage.createAppWithPrompt.noDataSources', 'No data sources found')}
              </div>
            ) : (
              datasources.map(({ id, name, kind }) => {
                const isSelected = selected.some((ds) => ds.id === id);
                return (
                  <button
                    key={id}
                    type="button"
                    className="tw-flex tw-w-full tw-cursor-pointer tw-items-center tw-justify-between tw-gap-2 tw-rounded-md tw-px-3 tw-py-2 tw-text-left tw-text-12 tw-text-text-default tw-outline-none hover:tw-bg-background-surface-layer-02"
                    onClick={() => onToggle({ id, name, kind })}
                    data-cy={`datasource-reference-option-${slugify(name)}`}
                  >
                    {name}
                    {isSelected && <span className="tw-text-11 tw-text-text-placeholder">✓</span>}
                  </button>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
};

const CreateAppWithPrompt = ({ createApp, variant = 'appsList' }) => {
  const { t } = useTranslation();
  // Memoized on `t` so the effect below (and its interval) only re-arms when the
  // language actually changes, not on every render.
  const rotatingExamples = useMemo(() => ROTATING_EXAMPLES(t), [t]);
  const exampleChips = EXAMPLE_CHIPS(t);
  const isHomeVariant = variant === 'home';
  const [prompt, setPrompt] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [taggedDatasources, setTaggedDatasources] = useState([]);
  const [exampleIndex, setExampleIndex] = useState(0);
  const hasPrompt = !!prompt.trim();

  // Rotating Tab-to-accept placeholder (home variant only): cycles through the
  // example prompts while the prompt is empty; typed text freezes the rotation.
  useEffect(() => {
    if (!isHomeVariant || hasPrompt) return undefined;
    const timer = setInterval(() => {
      setExampleIndex((index) => (index + 1) % rotatingExamples.length);
    }, ROTATION_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isHomeVariant, hasPrompt, rotatingExamples]);

  const handleCreate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed || isCreating) return;
    setIsCreating(true);
    try {
      const taggedResources = { datasources: taggedDatasources, tables: [] };
      await createApp(`Untitled App: ${uuidv4()}`, undefined, trimmed, taggedResources);
    } finally {
      // Only reached on failure — a successful createApp navigates away, unmounting this.
      setIsCreating(false);
    }
  };

  const toggleDatasource = (ds) => {
    setTaggedDatasources((current) =>
      current.some(({ id }) => id === ds.id) ? current.filter(({ id }) => id !== ds.id) : [...current, ds]
    );
  };

  const handleTabAccept = (docText) => {
    // Tab accepts the currently shown example while nothing has been typed yet;
    // with content the binding is consumed as a no-op (a plain Tab never
    // inserts anything into the prompt).
    if (isHomeVariant && !docText.trim()) {
      setPrompt(rotatingExamples[exampleIndex]);
    }
    return true;
  };

  // Stacked placeholder overlay (ticket #46): production renders all four
  // rotating lines at once — one `.active`, each with its own ⇥ Tab badge —
  // and cross-fades between them. Shown only while the prompt is empty.
  const stackedPlaceholderOverlay =
    isHomeVariant && !hasPrompt ? (
      <div
        className="tw-pointer-events-none tw-absolute tw-inset-0 tw-z-10 tw-flex tw-flex-col tw-justify-start tw-overflow-hidden"
        data-cy="prompt-placeholder-overlay"
      >
        {rotatingExamples.map((example, index) => (
          <div
            key={example}
            data-cy="prompt-placeholder-line"
            className={`prompt-placeholder-line tw-flex tw-h-[20px] tw-shrink-0 tw-items-center tw-gap-2 tw-transition-opacity tw-duration-500 ${
              index === exampleIndex ? 'active tw-opacity-100' : 'tw-opacity-0'
            } ${index > 0 ? 'tw--mt-[20px]' : ''}`}
          >
            <span className="tw-truncate tw-text-sm tw-text-text-placeholder">{example}</span>
            <kbd className="tw-flex tw-shrink-0 tw-items-center tw-rounded tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-02 tw-px-1 tw-py-0.5 tw-text-[10px] tw-text-text-placeholder">
              ⇥ Tab
            </kbd>
          </div>
        ))}
      </div>
    ) : null;

  return (
    <div className="tw-w-full" data-cy="create-app-with-prompt-wrapper">
      <div
        className="tw-flex tw-items-end tw-gap-2 tw-rounded-md tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-01 tw-p-3"
        data-cy="create-app-with-prompt"
      >
        <PromptEditor
          value={prompt}
          onChange={setPrompt}
          onSubmit={handleCreate}
          onTabAccept={handleTabAccept}
          disabled={isCreating}
          overlay={stackedPlaceholderOverlay}
          placeholder={
            isHomeVariant
              ? undefined
              : t('homePage.createAppWithPrompt.placeholder', 'Describe the app you want to build...')
          }
        />
        {taggedDatasources.length > 0 && (
          <div className="tw-flex tw-shrink-0 tw-flex-wrap tw-items-center tw-gap-1" data-cy="datasource-tags">
            {taggedDatasources.map((ds) => (
              <span
                key={ds.id}
                className="tw-flex tw-items-center tw-gap-1 tw-rounded-full tw-border tw-border-solid tw-border-border-weak tw-bg-background-surface-layer-02 tw-px-2 tw-py-0.5 tw-text-12 tw-text-text-default"
                data-cy={`datasource-tag-${slugify(ds.name)}`}
              >
                {ds.name}
                <button
                  type="button"
                  className="tw-flex tw-items-center tw-text-text-placeholder hover:tw-text-text-default"
                  aria-label={t('homePage.createAppWithPrompt.removeReference', 'Remove reference')}
                  onClick={() => toggleDatasource(ds)}
                  data-cy={`remove-datasource-tag-${slugify(ds.name)}`}
                >
                  <X width="12" height="12" />
                </button>
              </span>
            ))}
          </div>
        )}
        <DatasourceReferencePicker selected={taggedDatasources} onToggle={toggleDatasource} disabled={isCreating} />
        {isHomeVariant ? (
          // Home variant (ticket #45): empty input shows the "Example prompts" dropdown;
          // typed text swaps it (300ms ease) for the submit button — mutually exclusive,
          // matching the production reference.
          <>
            <div
              className={`tw-flex tw-items-center tw-justify-end tw-transition-all tw-duration-300 tw-ease-in-out ${
                hasPrompt ? 'tw-opacity-100 tw-translate-y-0' : 'tw-pointer-events-none tw-opacity-0 tw-translate-y-4'
              }`}
              data-cy="prompt-enter-button"
            >
              <Button
                iconOnly
                onClick={handleCreate}
                variant="primary"
                size="medium"
                disabled={isCreating || !hasPrompt}
                aria-label={t('homePage.createAppWithPrompt.submit', 'Create app')}
                data-cy="create-app-with-prompt-submit-button"
              >
                {isCreating ? <Spinner size="small" /> : <ArrowUp width="16" height="16" />}
              </Button>
            </div>
            <div
              className={`tw-flex tw-items-center tw-justify-end tw-transition-all tw-duration-300 tw-ease-in-out ${
                hasPrompt ? 'tw-pointer-events-none tw-opacity-0 tw-translate-y-4' : 'tw-opacity-100 tw-translate-y-0'
              }`}
              data-cy="example-prompts-wrapper"
            >
              <ExamplePromptsDropdown disabled={isCreating} onSelect={setPrompt} />
            </div>
          </>
        ) : (
          <Button
            iconOnly
            onClick={handleCreate}
            variant="primary"
            size="medium"
            disabled={isCreating || !hasPrompt}
            aria-label={t('homePage.createAppWithPrompt.submit', 'Create app')}
            data-cy="create-app-with-prompt-submit-button"
          >
            {isCreating ? <Spinner size="small" /> : <ArrowUp width="16" height="16" />}
          </Button>
        )}
      </div>
      {!isHomeVariant && (
        <div className="tw-mt-2 tw-flex tw-flex-wrap tw-items-center tw-gap-2" data-cy="example-prompts-row">
          <span className="tw-font-body-default tw-text-12 tw-text-text-placeholder">
            {t('homePage.createAppWithPrompt.tryTheseExamples', 'Try these examples to get started')}
          </span>
          {exampleChips.map(({ label, prompt: examplePrompt, Icon }) => (
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
