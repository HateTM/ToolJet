import WorkflowsPage from './pages/WorkflowsPage';

/* ADR-0047: Workflows ship fully in CE — no edition gating, so the CE page is
   exported directly instead of being wrapped in withEditionSpecificModule (which
   could only ever resolve an @ee module and redirected CE users to the dashboard). */
export default WorkflowsPage;
