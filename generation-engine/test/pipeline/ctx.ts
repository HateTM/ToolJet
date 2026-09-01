import { StageContext } from '../../../src/pipeline/types';
import { EffectiveLlmConfig } from '../../../src/config/provider';

export const TEST_LLM_CONFIG: EffectiveLlmConfig = {
  provider: 'openai',
  model: 'test-model',
  apiKey: 'test-key',
};

export function makeTestCtx(): StageContext {
  return { organizationId: 'org-1', llm: TEST_LLM_CONFIG };
}
