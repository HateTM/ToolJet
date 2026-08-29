import { renderHook } from '@testing-library/react';
import { useCreateAppFromPrompt } from '../useCreateAppFromPrompt';
import { appsService } from '@/_services';
import * as reactRouterDom from 'react-router-dom';

jest.mock('react-router-dom', () => ({
  useNavigate: jest.fn(),
}));

jest.mock('@/_services', () => ({
  appsService: { createApp: jest.fn() },
}));

jest.mock('@/_helpers/utils', () => ({
  getWorkspaceId: () => 'ws-1',
}));

jest.mock('@/modules/common/helpers/posthogHelper', () => ({
  captureEvent: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({ error: jest.fn(), success: jest.fn() }));

jest.mock('@/HomePage/Configs/AppIcon.json', () => ({ iconList: ['icon1'] }));

// Grab the factory-created fns through the mocked modules (avoids TDZ ordering issues
// with variables referenced from jest.mock factories).
const mockUseNavigate = reactRouterDom.useNavigate;
const mockNavigate = jest.fn();
const mockCreateApp = appsService.createApp;

beforeEach(() => {
  mockUseNavigate.mockReset().mockReturnValue(mockNavigate);
  mockNavigate.mockClear();
  mockCreateApp.mockClear().mockResolvedValue({ id: 'app-1' });
});

describe('useCreateAppFromPrompt', () => {
  it('threads taggedResources through the navigate state alongside the prompt', async () => {
    const { result } = renderHook(() => useCreateAppFromPrompt());
    const taggedResources = { datasources: [{ id: 'ds-1', name: 'Postgres', kind: 'postgresql' }], tables: [] };

    await result.current('My App', 'front-end', 'Build a CRM', taggedResources);

    expect(mockCreateApp).toHaveBeenCalledWith(expect.objectContaining({ name: 'My App', prompt: 'Build a CRM' }));
    expect(mockNavigate).toHaveBeenCalledWith('/ws-1/apps/app-1', {
      state: { prompt: 'Build a CRM', taggedResources },
    });
  });

  it('keeps the navigate state free of taggedResources when none were tagged', async () => {
    const { result } = renderHook(() => useCreateAppFromPrompt());

    await result.current('My App', 'front-end', 'Build a CRM');

    expect(mockNavigate).toHaveBeenCalledWith('/ws-1/apps/app-1', {
      state: { prompt: 'Build a CRM', taggedResources: undefined },
    });
  });
});
