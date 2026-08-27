import { fetchEdition } from '@/modules/common/helpers/utils';
import { getEditionSpecificSlice } from '@/modules/common/helpers/getEditionSpecificSlice';
import { createCeFixWithAiSlice } from './fixWithAiSlice';

// This fork implements the AI Builder directly in CE, where getEditionSpecificSlice would
// otherwise resolve to a no-op (there is no ee/ submodule to load a slice from). ee/cloud
// keep resolving their own slice from the registry, as before.
//
// The CE implementation lives in ./fixWithAiSlice so it can be exercised without pulling in
// the edition helpers, which reach `config` through a long import chain.
const createFixWithAiSlice =
  fetchEdition() === 'ce' ? createCeFixWithAiSlice : getEditionSpecificSlice('createFixWithAiSlice');

export { createFixWithAiSlice };
