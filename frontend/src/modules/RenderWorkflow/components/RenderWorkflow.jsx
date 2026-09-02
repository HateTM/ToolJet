import React from 'react';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';
import WorkflowEditorPage from '@/modules/workflows/pages/WorkflowEditorPage';

/* ADR-0047: workflow apps mount the workflow editor skeleton instead of redirecting away.
   AppsRoute resolves { id, slug, type, canEdit } for the /apps/:slug route and AppLoader
   forwards everything here. */
const RenderWorkflow = (props) => <WorkflowEditorPage {...props} />;

export default withEditionSpecificComponent(RenderWorkflow, 'RenderWorkflow');
