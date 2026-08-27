import { aiService } from '@/_services/ai.service';

/**
 * Per-field state for `Fix with AI` (CONTEXT.md), keyed exactly the way PreviewBox reads it:
 * `fixWithAiSlice[componentId][componentKey].chatHistory`, where componentKey is
 * `${componentName} - ${fieldDisplayName}`.
 *
 * `chatHistory` is an array only because PreviewBox already treats it as one (it checks
 * `chatList?.length` to decide whether a popover needs to fetch). It holds at most a single
 * entry: a fix request is one-shot, and Retry replaces that entry rather than appending, so
 * this never accumulates into a transcript (ADR-0014).
 *
 * An entry is `{ status: 'pending' | 'done' | 'error', suggestion?, error? }`.
 */
const initialState = {
  fixWithAiSlice: {},
};

/**
 * The one entry held for a field, or undefined if it has never asked. Reading the nested
 * shape lives here next to the code that writes it, so consumers don't carry a copy of the
 * `fixWithAiSlice[id][key].chatHistory[0]` walk.
 */
export const selectFixEntry = (state, componentId, componentKey) =>
  state?.fixWithAiSlice?.[componentId]?.[componentKey]?.chatHistory?.[0];

const setFieldEntry = (draft, componentId, componentKey, entry) => {
  if (!draft.fixWithAiSlice[componentId]) {
    draft.fixWithAiSlice[componentId] = {};
  }
  draft.fixWithAiSlice[componentId][componentKey] = { chatHistory: [entry] };
};

/**
 * The field's current source text — what the user actually typed, which is what needs
 * fixing. Deliberately not `error.resolvedProperty`: that holds the *resolved* value (see
 * where PreviewBox builds its error object), so sending it would ask the model to correct
 * the output rather than the binding that produced it.
 */
const toExpressionString = (currentValue) => {
  if (typeof currentValue === 'string') return currentValue;
  if (currentValue === undefined || currentValue === null) return '';
  return JSON.stringify(currentValue);
};

/**
 * A component's reported error isn't always a string — the resolver can hand back an array of
 * messages, which PreviewBox itself renders as `errMsg[0]`. The endpoint takes a string, so
 * the same first-message choice is made here rather than shipping an array the server would
 * have to reject.
 */
const toErrorMessageString = (message) => {
  if (Array.isArray(message)) return toErrorMessageString(message[0]);
  if (typeof message === 'string') return message;
  if (message === undefined || message === null) return '';
  return String(message);
};

/**
 * Assembles the `Error context` the endpoint expects. `effectiveProperty` is a single-key
 * object whose key is the property's param name — used as the property label when the field
 * has no display name of its own, and whose value is the fallback the property reverted to.
 */
const buildFixRequest = (errorData, meta) => {
  const effectiveProperty = errorData?.error?.effectiveProperty ?? {};
  const [paramName] = Object.keys(effectiveProperty);

  return {
    expression: toExpressionString(meta?.currentValue),
    errorMessage: toErrorMessageString(meta?.customErrMessage) || toErrorMessageString(errorData?.message),
    componentName: meta?.componentName,
    componentType: meta?.componentDisplayName,
    propertyName: meta?.errorPropertyDisplayName || paramName,
    fallbackValue: effectiveProperty[paramName],
  };
};

// aiService.fixWithAI rejects with `{ error, data, statusCode }` (handleAITextResponse), while
// a dropped connection rejects with a plain Error — both end up in the popover as text.
const readableError = (error) =>
  error?.error || error?.data?.message || error?.message || 'Something went wrong. Please try again.';

export const createCeFixWithAiSlice = (set) => ({
  ...initialState,

  /**
   * Asks for one `Suggestion` for the failing property described by `errorData`/`meta`
   * (the shapes PreviewBox already passes). Never throws: a failure is written into the
   * field's entry as `status: 'error'` so the popover can offer a manual retry, since
   * there is nothing useful to degrade to and no automatic retry (ADR-0014).
   */
  fetchErrorFixUsingAi: async (errorData, meta = {}) => {
    const componentId = errorData?.componentId;
    const componentKey = errorData?.key;

    if (!componentId || !componentKey) return;

    set(
      (draft) => {
        setFieldEntry(draft, componentId, componentKey, { status: 'pending' });
      },
      false,
      'fixWithAi/pending'
    );

    try {
      const suggestion = await aiService.fixWithAI(buildFixRequest(errorData, meta));

      set(
        (draft) => {
          setFieldEntry(draft, componentId, componentKey, { status: 'done', suggestion });
        },
        false,
        'fixWithAi/done'
      );
    } catch (error) {
      set(
        (draft) => {
          setFieldEntry(draft, componentId, componentKey, { status: 'error', error: readableError(error) });
        },
        false,
        'fixWithAi/error'
      );
    }
  },

  /**
   * Drops a field's entry entirely (rather than leaving an empty `chatHistory`), so the
   * next open of that popover fetches again — PreviewBox calls this whenever the field's
   * value changes, at which point any existing Suggestion is about a different expression.
   */
  clearChatHistory: (componentId, componentKey) => {
    set(
      (draft) => {
        if (!draft.fixWithAiSlice[componentId]) return;
        delete draft.fixWithAiSlice[componentId][componentKey];
        if (Object.keys(draft.fixWithAiSlice[componentId]).length === 0) {
          delete draft.fixWithAiSlice[componentId];
        }
      },
      false,
      'fixWithAi/clearChatHistory'
    );
  },
});
