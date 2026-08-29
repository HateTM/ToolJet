import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StepProgressList } from '../AiBuilderChatPanel';

// react-i18next's `t(key, fallback)` — the component always passes an English fallback, so
// the tests can query by the same visible text a user would see.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

// lucide-react is ESM-only and outside this repo's Jest transform allowlist; the icons
// contribute nothing the tests assert on beyond being rendered, so they collapse to spans.
jest.mock('lucide-react', () => ({
  __esModule: true,
  History: (props) => <span {...props} />,
  Plus: (props) => <span {...props} />,
  X: (props) => <span {...props} />,
  ArrowUp: (props) => <span {...props} />,
  Check: (props) => <span {...props} />,
  Circle: (props) => <span {...props} />,
  RotateCcw: (props) => <span {...props} />,
  ThumbsUp: (props) => <span {...props} />,
  ThumbsDown: (props) => <span {...props} />,
  RefreshCw: (props) => <span {...props} />,
  Hammer: (props) => <span {...props} />,
  SkipForward: (props) => <span {...props} />,
}));

jest.mock('@/_ui/Spinner', () => () => <span data-cy="spinner" />);
// The design-system Button reaches lucide-react's ESM-only dynamic.mjs (same reason the
// Copilot tests mock it); StepProgressList renders plain <button>s, so it collapses.
jest.mock('@/components/ui/Button/Button', () => {
  const MockReact = require('react');
  return {
    Button: ({ children, ...props }) => MockReact.createElement('button', { type: 'button', ...props }, children),
  };
});
jest.mock('../SchemaPreview', () => () => null);
jest.mock('@/_stores/aiBuilderStore', () => ({
  __esModule: true,
  default: () => ({}),
}));

const renderList = (props) =>
  render(<StepProgressList steps={[]} onRewind={jest.fn()} onSkip={jest.fn()} onUndoBuild={jest.fn()} {...props} />);

// Ticket #15: the "Undo this build" offer's resting state — it appears on a stopped plan
// that both failed somewhere and built something, and never otherwise.
describe('StepProgressList undo offer (ticket #15)', () => {
  const failedBuildSteps = [
    {
      id: 'step-1',
      type: 'CreateTable',
      description: 'Create a table',
      status: 'succeeded',
    },
    {
      id: 'step-2',
      type: 'CreateQuery',
      description: 'Query it',
      status: 'failed',
      errorMessage: 'boom',
    },
    {
      id: 'step-3',
      type: 'CreateComponent',
      description: 'Add a chart',
      status: 'pending',
    },
  ];

  it('offers the undo action on a failed plan that built something first', () => {
    renderList({ steps: failedBuildSteps });

    expect(screen.getByText('Undo this build')).toBeInTheDocument();
  });

  it('calls onUndoBuild when the action is clicked', async () => {
    const onUndoBuild = jest.fn();
    renderList({ steps: failedBuildSteps, onUndoBuild });

    await userEvent.click(screen.getByText('Undo this build'));

    expect(onUndoBuild).toHaveBeenCalledTimes(1);
  });

  it('is disabled while an undo is in flight', () => {
    renderList({ steps: failedBuildSteps, undoingBuild: true });

    expect(screen.getByRole('button', { name: 'Undo this build' })).toBeDisabled();
  });

  it('is hidden while the plan is still executing', () => {
    renderList({ steps: failedBuildSteps, isExecuting: true });

    expect(screen.queryByText('Undo this build')).not.toBeInTheDocument();
  });

  it('is hidden when nothing was built (the plan failed at its first step)', () => {
    renderList({
      steps: [
        {
          id: 'step-1',
          type: 'CreateTable',
          description: 'Create a table',
          status: 'failed',
          errorMessage: 'boom',
        },
      ],
    });

    expect(screen.queryByText('Undo this build')).not.toBeInTheDocument();
  });

  it('is hidden when the plan has no failure (rewind per step is the tool there, not undo)', () => {
    renderList({
      steps: [
        {
          id: 'step-1',
          type: 'CreateTable',
          description: 'Create a table',
          status: 'succeeded',
        },
        {
          id: 'step-2',
          type: 'CreateQuery',
          description: 'Query it',
          status: 'pending',
        },
      ],
    });

    expect(screen.queryByText('Undo this build')).not.toBeInTheDocument();
  });
});
