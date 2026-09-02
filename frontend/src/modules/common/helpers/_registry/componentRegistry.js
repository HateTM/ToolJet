import * as ceWorkflows from '@/modules/workflows';
/* EE-only modules: resolve to the empty module in CE builds via webpack's
   NormalModuleReplacementPlugin, so the import resolver can't see them. */
// eslint-disable-next-line import/no-unresolved
import * as eeInstanceSettings from '@ee/modules/InstanceSettings';
// eslint-disable-next-line import/no-unresolved
import * as eeWorkspaceSettings from '@ee/modules/WorkspaceSettings';

export const componentRegistry = {
  ee: {
    InstanceSettings: eeInstanceSettings,
    /* ADR-0047: Workflows ship as first-class CE code — no edition resolves an
       empty workflows namespace, the CE module is the implementation everywhere. */
    Workflows: ceWorkflows,
    WorkspaceSettings: eeWorkspaceSettings,
  },
  cloud: {
    WorkspaceSettings: eeWorkspaceSettings,
  },
};
