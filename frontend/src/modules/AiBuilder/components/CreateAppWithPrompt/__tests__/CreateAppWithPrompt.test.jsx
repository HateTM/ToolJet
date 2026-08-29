import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateAppWithPrompt from '../CreateAppWithPrompt';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

jest.mock('lucide-react', () => ({
  __esModule: true,
  ArrowUp: (props) => <span {...props} />,
  ListTodo: (props) => <span {...props} />,
  Bug: (props) => <span {...props} />,
  Users: (props) => <span {...props} />,
  Truck: (props) => <span {...props} />,
  Database: (props) => <span {...props} />,
  X: (props) => <span {...props} />,
}));

jest.mock('@/components/ui/Button/Button', () => {
  const MockReact = require('react');
  return {
    Button: ({ children, ...props }) => MockReact.createElement('button', { type: 'button', ...props }, children),
  };
});

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

jest.mock('@/_services', () => ({
  globalDatasourceService: { getAll: jest.fn() },
}));

import { globalDatasourceService } from '@/_services';

const mockGetAllDatasources = globalDatasourceService.getAll;

jest.mock('@/_helpers/utils', () => ({
  getWorkspaceId: () => 'ws-1',
}));

// The edition-specific HOC pulls in `config` (unresolvable under Jest); identity-mock it.
jest.mock('@/modules/common/helpers/withEditionSpecificComponent', () => ({
  withEditionSpecificComponent: (Component) => Component,
}));

// @/_ui/Spinner pulls the full zustand store graph; only its render matters here.
jest.mock('@/_ui/Spinner', () => () => <span data-cy="spinner" />);

const createApp = jest.fn().mockResolvedValue({ id: 'app-1' });

const cy = (selector) => document.querySelector(`[data-cy="${selector}"]`);

// Ticket #46: the prompt input is a CodeMirror 6 editor now. The editable
// content is `.cm-content` inside the `prompt-textarea` wrapper — the same path
// the cypress `clearAndTypeOnCodeMirror` helper drives.
const editorContent = () => document.querySelector('[data-cy="prompt-textarea"] .cm-content');
const editorValue = () => editorContent()?.textContent ?? '';

// Radix dropdowns position via floating-ui, which requires ResizeObserver (absent in jsdom).
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = global.ResizeObserver || ResizeObserverMock;

// jsdom's Range has no client-rect geometry, which CodeMirror's measurement
// pass calls on every draw — stub the rects as empty.
beforeAll(() => {
  const originalCreateRange = document.createRange.bind(document);
  document.createRange = () => {
    const range = originalCreateRange();
    range.getClientRects = () => [];
    range.getBoundingClientRect = () => ({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });
    return range;
  };
});

const EMPTY_TAGGED_RESOURCES = { datasources: [], tables: [] };

beforeEach(() => {
  createApp.mockClear();
  mockGetAllDatasources.mockReset().mockResolvedValue([
    { id: 'ds-1', name: 'Postgres', kind: 'postgresql' },
    { id: 'ds-2', name: 'Users DB', kind: 'postgresql' },
  ]);
});

describe('CreateAppWithPrompt — apps-list variant (default)', () => {
  it('renders the example chip row and fills the editor on click without submitting', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} />);

    expect(screen.getByText('Try these examples to get started')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Task manager' }));

    expect(editorValue()).toBe('Build a task management app for a small team');
    expect(createApp).not.toHaveBeenCalled();
  });

  it('still submits via Enter after a chip fills the editor', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} />);

    await user.click(screen.getByRole('button', { name: 'Employee directory' }));
    await user.type(editorContent(), '{Enter}');

    expect(createApp).toHaveBeenCalledWith(
      'Untitled App: test-uuid',
      undefined,
      'Build an employee directory for a mid-size company',
      EMPTY_TAGGED_RESOURCES
    );
  });
});

describe('CreateAppWithPrompt — home variant', () => {
  it('shows the stacked placeholder overlay and accepts the active example with Tab without submitting', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    // Ticket #46: all four rotating lines render at once, one active, each with
    // its own ⇥ Tab badge — matching the production stacked overlay.
    const overlay = cy('prompt-placeholder-overlay');
    expect(overlay).toBeInTheDocument();
    const lines = overlay.querySelectorAll('[data-cy="prompt-placeholder-line"]');
    expect(lines).toHaveLength(4);
    expect(overlay.querySelectorAll('kbd')).toHaveLength(4);
    expect(overlay.querySelectorAll('.tw-opacity-100')).toHaveLength(1);
    expect(lines[0]).toHaveTextContent('Build an inventory management system for a manufacturing company');

    await user.tab();
    await user.type(editorContent(), '{Tab}');

    expect(editorValue()).toBe('Build an inventory management system for a manufacturing company');
    expect(createApp).not.toHaveBeenCalled();
  });

  it('Tab never inserts anything once the editor has content', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    await user.type(editorContent(), 'my own idea');
    await user.type(editorContent(), '{Tab}');

    expect(editorValue()).toBe('my own idea');
    expect(createApp).not.toHaveBeenCalled();
  });

  it('keeps the default static placeholder on the apps-list variant', () => {
    render(<CreateAppWithPrompt createApp={createApp} />);

    // CodeMirror renders the placeholder as a span, not an attribute.
    expect(document.querySelector('[data-cy="prompt-textarea"] .cm-placeholder')).toHaveTextContent(
      'Describe the app you want to build...'
    );
  });
});

describe('CreateAppWithPrompt — datasource tagging (ticket #47)', () => {
  it('passes tagged datasources to createApp as taggedResources', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    await user.click(cy('datasource-reference-button'));
    await waitFor(() => cy('datasource-reference-option-postgres'));

    await user.click(cy('datasource-reference-option-postgres'));

    expect(cy('datasource-tag-postgres')).toBeInTheDocument();
    expect(mockGetAllDatasources).toHaveBeenCalledWith('ws-1');

    await user.type(editorContent(), 'Build a CRM');
    await user.type(editorContent(), '{Enter}');

    expect(createApp).toHaveBeenCalledWith('Untitled App: test-uuid', undefined, 'Build a CRM', {
      datasources: [{ id: 'ds-1', name: 'Postgres', kind: 'postgresql' }],
      tables: [],
    });
  });

  it('removes a tagged datasource when its chip is dismissed', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    await user.click(cy('datasource-reference-button'));
    await waitFor(() => cy('datasource-reference-option-users-db'));
    await user.click(cy('datasource-reference-option-users-db'));

    expect(cy('datasource-tag-users-db')).toBeInTheDocument();

    await user.click(cy('remove-datasource-tag-users-db'));

    expect(cy('datasource-tag-users-db')).not.toBeInTheDocument();

    await user.type(editorContent(), 'Build a CRM');
    await user.type(editorContent(), '{Enter}');

    expect(createApp).toHaveBeenCalledWith('Untitled App: test-uuid', undefined, 'Build a CRM', EMPTY_TAGGED_RESOURCES);
  });

  it('never duplicates a tag: selecting the option again toggles it off', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    await user.click(cy('datasource-reference-button'));
    await waitFor(() => cy('datasource-reference-option-postgres'));
    await user.click(cy('datasource-reference-option-postgres'));
    await user.click(cy('datasource-reference-option-postgres'));

    expect(document.querySelectorAll('[data-cy="datasource-tag-postgres"]').length).toBeLessThan(2);
  });
});
