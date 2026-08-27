import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Mutable, so a test can turn the gates off without re-mocking the module.
const mockStoreState = {
  ai: { aiFeaturesEnabled: true },
  appStore: { modules: { canvas: { app: { appId: 'app-1' } } } },
};
let mockIsAiBlockedByBranch = false;

jest.mock('@/AppBuilder/_stores/store', () => ({
  __esModule: true,
  default: (selector) => selector(mockStoreState),
}));

jest.mock('@/AppBuilder/_contexts/ModuleContext', () => ({
  useModuleContext: () => ({ moduleId: 'canvas' }),
}));

jest.mock('@/_hooks/useIsAiBlockedOnDefaultBranch', () => ({
  useIsAiBlockedOnDefaultBranch: () => mockIsAiBlockedByBranch,
}));

jest.mock('@/_services/ai.service', () => ({
  aiService: {
    getCopilotSuggestion: jest.fn(),
  },
}));

// react-i18next's `t(key, fallback)` — the component always passes an English fallback, so
// the tests can query by the same visible text a user would see.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

// The design-system Button reaches lucide-react's ESM-only `dynamic.mjs`, which this repo's
// Jest transform does not cover. It contributes nothing the tests assert on beyond rendering
// its children and forwarding onClick/disabled, so it collapses to a plain <button>.
jest.mock('@/components/ui/Button/Button', () => {
  const MockReact = require('react');
  return {
    // The styling props are dropped rather than forwarded, so React doesn't warn about
    // unknown attributes on a real <button>.
    Button: ({
      children,
      iconOnly: _iconOnly,
      variant: _variant,
      size: _size,
      isLucid: _isLucid,
      leadingIcon: _leadingIcon,
      fill: _fill,
      ...props
    }) => MockReact.createElement('button', props, children),
  };
});

// Radix's popover renders through a portal and measures the DOM; none of that is this
// component's behaviour to prove, so the primitives collapse to plain elements and the
// content is always mounted.
jest.mock('@radix-ui/react-popover', () => {
  const MockReact = require('react');
  return {
    Root: ({ children }) => MockReact.createElement('div', null, children),
    Trigger: ({ children }) => MockReact.createElement('div', null, children),
    Portal: ({ children }) => MockReact.createElement('div', null, children),
    Content: ({ children, ...props }) => MockReact.createElement('div', props, children),
  };
});

// eslint-disable-next-line import/first
import { aiService } from '@/_services/ai.service';
// eslint-disable-next-line import/first
import Copilot from '../Copilot';

const EDITOR_CODE = 'return [];';

const buildEditorRef = (code = EDITOR_CODE) => ({
  current: { view: { state: { doc: { toString: () => code } } } },
});

const renderCopilot = (overrides = {}) => {
  const onAiSuggestionAccept = jest.fn();
  const props = {
    darkMode: false,
    language: 'javascript',
    editorRef: buildEditorRef(),
    onAiSuggestionAccept,
    selectedDataSource: { kind: 'runjs' },
    ...overrides,
  };
  return { onAiSuggestionAccept, ...render(<Copilot {...props} />) };
};

const typePrompt = async (user, text) => {
  await user.type(screen.getByLabelText('Describe what this query should do'), text);
};

describe('Copilot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStoreState.ai.aiFeaturesEnabled = true;
    mockIsAiBlockedByBranch = false;
  });

  // The same gate as the Fix with AI trigger: no AI licence, no affordance at all - not a
  // button that explains itself only after being clicked.
  it('renders nothing when AI features are disabled', () => {
    mockStoreState.ai.aiFeaturesEnabled = false;

    const { container } = renderCopilot();

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when AI is blocked on the default branch', () => {
    mockIsAiBlockedByBranch = true;

    const { container } = renderCopilot();

    expect(container).toBeEmptyDOMElement();
  });

  // renderCopilot reaches every multi-line code field a plugin declares, including the SQL
  // editors of postgresql and friends. The prompt behind this feature describes the JS/Python
  // query runtime, so offering it there would answer a SQL box with JavaScript (ADR-0015).
  it.each([['sql'], ['sass'], [undefined]])('renders nothing for a %s editor', (language) => {
    const { container } = renderCopilot({ language });

    expect(container).toBeEmptyDOMElement();
  });

  it('renders for the javascript and python editors it is scoped to', () => {
    expect(renderCopilot({ language: 'javascript' }).container).not.toBeEmptyDOMElement();
    expect(renderCopilot({ language: 'python' }).container).not.toBeEmptyDOMElement();
  });

  // ADR-0015: nothing is requested that the user did not click for.
  it('cannot generate until the user has actually described something', async () => {
    const user = userEvent.setup();
    renderCopilot();

    expect(screen.getByText('Generate code').closest('button')).toBeDisabled();

    await typePrompt(user, '   ');
    expect(screen.getByText('Generate code').closest('button')).toBeDisabled();
    expect(aiService.getCopilotSuggestion).not.toHaveBeenCalled();
  });

  // ADR-0016: the App inventory is assembled server-side from appId, and the editor's own
  // contents go along so the completion can extend the user's work rather than replace it blind.
  it('sends the prompt with the editor context the completion has to be grounded in', async () => {
    const user = userEvent.setup();
    aiService.getCopilotSuggestion.mockResolvedValue({ code: 'return 1;', explanation: 'Returns one.' });
    renderCopilot();

    await typePrompt(user, 'keep only the active users');
    await user.click(screen.getByText('Generate code'));

    await waitFor(() => expect(aiService.getCopilotSuggestion).toHaveBeenCalledTimes(1));
    expect(aiService.getCopilotSuggestion).toHaveBeenCalledWith({
      prompt: 'keep only the active users',
      currentCode: EDITOR_CODE,
      language: 'javascript',
      dataSourceKind: 'runjs',
      appId: 'app-1',
    });
  });

  it('shows the Completion verbatim before anything is written over the editor', async () => {
    const user = userEvent.setup();
    aiService.getCopilotSuggestion.mockResolvedValue({
      code: 'const users = await queries.getUsers.run();\nreturn users;',
      explanation: 'Runs getUsers and returns the rows.',
    });
    const { onAiSuggestionAccept } = renderCopilot();

    await typePrompt(user, 'fetch the users');
    await user.click(screen.getByText('Generate code'));

    expect(await screen.findByText('Runs getUsers and returns the rows.')).toBeInTheDocument();
    expect(screen.getByText(/queries\.getUsers\.run\(\)/)).toBeInTheDocument();
    // Nothing lands in the editor until the user says so.
    expect(onAiSuggestionAccept).not.toHaveBeenCalled();

    await user.click(screen.getByText('Replace editor contents'));
    expect(onAiSuggestionAccept).toHaveBeenCalledWith('const users = await queries.getUsers.run();\nreturn users;');
  });

  it('offers a retry that re-asks, rather than leaving a dead popover, when the request fails', async () => {
    const user = userEvent.setup();
    aiService.getCopilotSuggestion.mockRejectedValueOnce({ error: 'The model is unreachable' });
    renderCopilot();

    await typePrompt(user, 'fetch the users');
    await user.click(screen.getByText('Generate code'));

    expect(await screen.findByText('The model is unreachable')).toBeInTheDocument();

    aiService.getCopilotSuggestion.mockResolvedValue({ code: 'return 1;', explanation: 'Returns one.' });
    await user.click(screen.getByText('Try again'));

    expect(await screen.findByText('Returns one.')).toBeInTheDocument();
    expect(aiService.getCopilotSuggestion).toHaveBeenCalledTimes(2);
  });

  // Closing with a request still in flight: the response must not repopulate a popover the
  // user has dismissed, or reopening it would show a Completion written against editor
  // contents that have since moved on - with an Apply that silently reverts them.
  it('drops a response that lands after the popover was closed, but keeps the prompt', async () => {
    const user = userEvent.setup();
    let resolvePending;
    aiService.getCopilotSuggestion.mockImplementationOnce(() => new Promise((resolve) => (resolvePending = resolve)));
    renderCopilot();

    await typePrompt(user, 'fetch the users');
    await user.click(screen.getByText('Generate code'));
    expect(await screen.findByText('Writing the code…')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Close'));

    resolvePending({ code: 'return 1;', explanation: 'The dismissed answer.' });

    await waitFor(() => expect(screen.getByText('Generate code')).toBeInTheDocument());
    expect(screen.queryByText('The dismissed answer.')).not.toBeInTheDocument();
    // The prompt is the user's own typing - a dismissal must not cost it.
    expect(screen.getByLabelText('Describe what this query should do')).toHaveValue('fetch the users');
  });
});
