import { aiService } from '@/_services/ai.service';

jest.mock('@/_services/ai.service', () => ({
  aiService: {
    fixWithAI: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import { createCeFixWithAiSlice } from '../fixWithAiSlice';
// eslint-disable-next-line import/first
import { produce } from 'immer';

const COMPONENT_ID = 'component-1';
const COMPONENT_KEY = 'table1 - Data';

// Stands in for the store's Immer-wrapped `set`: slices mutate a draft, and the extra
// (replace, actionName) args the real store takes are ignored here.
const buildSlice = () => {
  let state = {};
  const set = (updater) => {
    state = produce(state, updater);
  };
  const slice = createCeFixWithAiSlice(set);
  state = { ...slice };
  return {
    slice,
    getEntry: () => state.fixWithAiSlice?.[COMPONENT_ID]?.[COMPONENT_KEY]?.chatHistory?.[0],
    getState: () => state,
  };
};

// The shapes PreviewBox actually passes to fetchErrorFixUsingAi.
const errorData = {
  key: COMPONENT_KEY,
  componentId: COMPONENT_ID,
  message: 'ReferenceError: queries.getusers is not defined',
  error: {
    resolvedProperty: { data: undefined },
    effectiveProperty: { data: [] },
    componentId: COMPONENT_ID,
  },
};

const meta = {
  componentDisplayName: 'Table',
  errorPropertyDisplayName: 'Data',
  customErrMessage: 'queries.getusers is not defined',
  currentValue: '{{queries.getusers.data}}',
  componentName: 'table1',
};

describe('createCeFixWithAiSlice', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('starts empty', () => {
    const { getState } = buildSlice();

    expect(getState().fixWithAiSlice).toEqual({});
  });

  it('sends the failing source expression, not the resolved value', async () => {
    aiService.fixWithAI.mockResolvedValue({ fixedValue: '{{queries.getUsers.data}}', explanation: 'Typo.' });
    const { slice } = buildSlice();

    await slice.fetchErrorFixUsingAi(errorData, meta);

    expect(aiService.fixWithAI).toHaveBeenCalledWith({
      expression: '{{queries.getusers.data}}',
      errorMessage: 'queries.getusers is not defined',
      componentName: 'table1',
      componentType: 'Table',
      propertyName: 'Data',
      fallbackValue: [],
    });
  });

  // PreviewBox renders an array error as errMsg[0]; the request has to make the same choice
  // rather than shipping an array the endpoint rejects.
  it('flattens an array error message to its first entry', async () => {
    aiService.fixWithAI.mockResolvedValue({ fixedValue: '{{a}}', explanation: 'Typo.' });
    const { slice } = buildSlice();

    await slice.fetchErrorFixUsingAi(errorData, {
      ...meta,
      customErrMessage: ['queries.getusers is not defined', 'second message'],
    });

    expect(aiService.fixWithAI).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'queries.getusers is not defined' })
    );
  });

  it('falls back to the error data message when meta carries none', async () => {
    aiService.fixWithAI.mockResolvedValue({ fixedValue: '{{a}}', explanation: 'Typo.' });
    const { slice } = buildSlice();

    await slice.fetchErrorFixUsingAi(errorData, { ...meta, customErrMessage: undefined });

    expect(aiService.fixWithAI).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'ReferenceError: queries.getusers is not defined' })
    );
  });

  it('stores the Suggestion as the field’s single entry', async () => {
    aiService.fixWithAI.mockResolvedValue({ fixedValue: '{{queries.getUsers.data}}', explanation: 'Typo.' });
    const { slice, getEntry, getState } = buildSlice();

    await slice.fetchErrorFixUsingAi(errorData, meta);

    expect(getEntry()).toEqual({
      status: 'done',
      suggestion: { fixedValue: '{{queries.getUsers.data}}', explanation: 'Typo.' },
    });
    expect(getState().fixWithAiSlice[COMPONENT_ID][COMPONENT_KEY].chatHistory).toHaveLength(1);
  });

  it('surfaces a failed request as an error entry instead of throwing', async () => {
    aiService.fixWithAI.mockRejectedValue({ error: 'LLM unreachable' });
    const { slice, getEntry } = buildSlice();

    await expect(slice.fetchErrorFixUsingAi(errorData, meta)).resolves.toBeUndefined();
    expect(getEntry()).toEqual({ status: 'error', error: 'LLM unreachable' });
  });

  // ADR-0014: retry replaces the entry, so the list never grows into a transcript.
  it('replaces the previous entry on retry rather than appending', async () => {
    aiService.fixWithAI.mockRejectedValueOnce({ error: 'LLM unreachable' });
    aiService.fixWithAI.mockResolvedValueOnce({ fixedValue: '{{queries.getUsers.data}}', explanation: 'Typo.' });
    const { slice, getState } = buildSlice();

    await slice.fetchErrorFixUsingAi(errorData, meta);
    await slice.fetchErrorFixUsingAi(errorData, meta);

    const history = getState().fixWithAiSlice[COMPONENT_ID][COMPONENT_KEY].chatHistory;
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('done');
  });

  it('does nothing without a component id or field key', async () => {
    const { slice, getState } = buildSlice();

    await slice.fetchErrorFixUsingAi({ ...errorData, componentId: undefined }, meta);

    expect(aiService.fixWithAI).not.toHaveBeenCalled();
    expect(getState().fixWithAiSlice).toEqual({});
  });

  // PreviewBox clears on every value change; the next open must fetch again rather than
  // showing a Suggestion about an expression the user has since edited.
  it('clearChatHistory drops the field entry entirely', async () => {
    aiService.fixWithAI.mockResolvedValue({ fixedValue: '{{queries.getUsers.data}}', explanation: 'Typo.' });
    const { slice, getState } = buildSlice();

    await slice.fetchErrorFixUsingAi(errorData, meta);
    slice.clearChatHistory(COMPONENT_ID, COMPONENT_KEY);

    expect(getState().fixWithAiSlice[COMPONENT_ID]).toBeUndefined();
  });

  it('clearChatHistory is a no-op for a field that never asked', () => {
    const { slice, getState } = buildSlice();

    expect(() => slice.clearChatHistory('unknown-component', 'unknown - Field')).not.toThrow();
    expect(getState().fixWithAiSlice).toEqual({});
  });
});
