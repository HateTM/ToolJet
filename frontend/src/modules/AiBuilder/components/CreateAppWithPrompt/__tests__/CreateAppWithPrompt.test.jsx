import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
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
}));

jest.mock('@/components/ui/Button/Button', () => {
  const MockReact = require('react');
  return {
    Button: ({ children, ...props }) => MockReact.createElement('button', { type: 'button', ...props }, children),
  };
});

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

// The edition-specific HOC pulls in `config` (unresolvable under Jest); identity-mock it.
jest.mock('@/modules/common/helpers/withEditionSpecificComponent', () => ({
  withEditionSpecificComponent: (Component) => Component,
}));

// @/_ui/Spinner pulls the full zustand store graph; only its render matters here.
jest.mock('@/_ui/Spinner', () => () => <span data-cy="spinner" />);

const createApp = jest.fn().mockResolvedValue({ id: 'app-1' });

beforeEach(() => {
  createApp.mockClear();
});

describe('CreateAppWithPrompt — apps-list variant (default)', () => {
  it('renders the example chip row and fills the textarea on click without submitting', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} />);

    expect(screen.getByText('Try these examples to get started')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Task manager' }));

    expect(screen.getByRole('textbox')).toHaveValue('Build a task management app for a small team');
    expect(createApp).not.toHaveBeenCalled();
  });

  it('still submits via Enter after a chip fills the textarea', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} />);

    await user.click(screen.getByRole('button', { name: 'Employee directory' }));
    await user.type(screen.getByRole('textbox'), '{Enter}');

    expect(createApp).toHaveBeenCalledWith(
      'Untitled App: test-uuid',
      undefined,
      'Build an employee directory for a mid-size company'
    );
  });
});

describe('CreateAppWithPrompt — home variant', () => {
  it('accepts the rotating placeholder example with Tab without submitting', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('placeholder', 'Build an inventory management system for a manufacturing company');

    await user.tab();
    await user.type(textarea, '{Tab}');

    expect(textarea).toHaveValue('Build an inventory management system for a manufacturing company');
    expect(createApp).not.toHaveBeenCalled();
  });

  it('Tab types through normally once the textarea has content', async () => {
    const user = userEvent.setup();
    render(<CreateAppWithPrompt createApp={createApp} variant="home" />);

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'my own idea');
    await user.type(textarea, '{Tab}');

    expect(textarea).toHaveValue('my own idea');
    expect(createApp).not.toHaveBeenCalled();
  });

  it('keeps the default static placeholder on the apps-list variant', () => {
    render(<CreateAppWithPrompt createApp={createApp} />);

    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Describe the app you want to build...');
  });
});
