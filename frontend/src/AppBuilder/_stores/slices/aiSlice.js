import { fetchEdition } from '@/modules/common/helpers/utils';
import { getEditionSpecificSlice } from '@/modules/common/helpers/getEditionSpecificSlice';
import { aiService } from '@/_services/ai.service';

/**
 * CE's `state.ai`, deliberately minimal: only `aiFeaturesEnabled`, which is what gates the
 * `Fix with AI` trigger on a failing property (PreviewBox). The chat panel in this fork keeps
 * its own state in `_stores/aiBuilderStore` and does not read this slice, so the conversation
 * plumbing EE's version of this slice carries has no CE counterpart to mirror here.
 *
 * Self-hosted CE has no credit accounting — the server's getCreditsBalance answers
 * `{ aiFeaturesEnabled: true }` unconditionally and never touches the LLM — so this call only
 * establishes that the AI endpoints are reachable and licensed for this user, not that the
 * configured LocalAI endpoint actually works. A broken model config still surfaces later, as
 * a failed request inside the popover.
 */
const createCeAiSlice = (set) => ({
  ai: {
    aiFeaturesEnabled: false,

    getCreditBalance: async () => {
      try {
        const response = await aiService.getCreditBalance();
        set(
          (draft) => {
            draft.ai.aiFeaturesEnabled = !!response?.aiFeaturesEnabled;
          },
          false,
          'ai/getCreditBalance'
        );
      } catch {
        set(
          (draft) => {
            draft.ai.aiFeaturesEnabled = false;
          },
          false,
          'ai/getCreditBalance/failed'
        );
      }
    },
  },
});

// See the matching note in slices/fixWithAi.js: CE gets a real slice here because
// getEditionSpecificSlice has no ee/ submodule to resolve one from in this fork.
const createAiSlice = fetchEdition() === 'ce' ? createCeAiSlice : getEditionSpecificSlice('createAiSlice');

export { createAiSlice };
