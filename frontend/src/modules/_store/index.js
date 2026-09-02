import * as onboardingStores from '../onboarding/stores';
import useWorkflowStore from '@/_stores/workflowStore';

/* CE mirror of `@ee/modules/_store`. Keeps every store resolvable through
   getEditionSpecificStore — including workflowStore, which ships in CE per ADR-0047. */
export const stores = {
  ...onboardingStores,
  workflowStore: useWorkflowStore,
};
