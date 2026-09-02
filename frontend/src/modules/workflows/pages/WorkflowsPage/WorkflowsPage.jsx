import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import moment from 'moment';
import { toast } from 'react-hot-toast';
import { appsService, authenticationService } from '@/_services';
import { getPrivateRoute } from '@/_helpers/routes';
import { validateName, decodeEntities } from '@/_helpers/utils';
import { processErrorMessage } from '@/modules/common/helpers/utils';
import { ButtonSolid } from '@/_ui/AppButton/AppButton';
import SolidIcon from '@/_ui/Icon/SolidIcons';
import { TJLoader } from '@/_ui/TJLoader';
import Layout from '@/_ui/Layout';

const isValidSlug = (slug) => validateName(slug, 'slug', true, false, false, false).status;

/* ADR-0047: Workflows are a first-class CE module. WP-1 ships the navigation skeleton —
   the full list UX (folders, search, pagination) lands with the editor workpackages. */
const WorkflowsPage = ({ darkMode, switchDarkMode }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [apps, setApps] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  /* Mirrors HomePage.canUserPerform('create') for workflow apps. */
  const canCreateWorkflow = (() => {
    const { super_admin, admin, user_permissions: userPermissions } = authenticationService.currentSessionValue ?? {};
    return super_admin || admin || userPermissions?.workflow_create;
  })();

  useEffect(() => {
    appsService
      .getAll(0, '', '', 'workflow')
      .then((data) => setApps(data?.apps ?? []))
      .catch((error) => toast.error(processErrorMessage(error), { style: { maxWidth: '400px' } }))
      .finally(() => setIsLoading(false));
  }, []);

  const editorRoute = (app) => getPrivateRoute('editor', { slug: isValidSlug(app?.slug) ? app?.slug : app?.id });

  const createWorkflow = () => {
    setIsCreating(true);
    appsService
      .createApp({
        name: t('workflowsDashboard.header.untitledWorkflow', 'Untitled workflow'),
        type: 'workflow',
      })
      .then((data) => navigate(editorRoute(data)))
      .catch((error) => toast.error(processErrorMessage(error), { style: { maxWidth: '400px' } }))
      .finally(() => setIsCreating(false));
  };

  return (
    <Layout switchDarkMode={switchDarkMode} darkMode={darkMode}>
      <div className="tw-flex tw-flex-col tw-w-full">
        <div className="tw-flex tw-items-center tw-justify-between tw-w-full tw-px-8 tw-pt-6">
          <h2 className="tw-text-text-default tw-font-medium" data-cy="workflows-page-title">
            {t('workflowsDashboard.page.title', 'Workflows')}
          </h2>
          {canCreateWorkflow && (
            <ButtonSolid
              onClick={createWorkflow}
              isLoading={isCreating}
              data-cy="create-new-workflow-button"
              className="tw-gap-2"
            >
              {t('workflowsDashboard.header.createNewApplication', 'Create new workflow')}
            </ButtonSolid>
          )}
        </div>
        <div className="tw-flex tw-flex-col tw-gap-2 tw-w-full tw-px-8 tw-pt-4 tw-pb-8">
          {isLoading ? (
            <TJLoader />
          ) : apps.length === 0 ? (
            <p className="tw-text-text-placeholder" data-cy="no-workflows-message">
              {t('homePage.noWorkflowFound', 'No workflows found')}
            </p>
          ) : (
            apps.map((app) => (
              <div
                key={app?.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(editorRoute(app))}
                className="tw-flex tw-items-center tw-justify-between tw-px-4 tw-py-3 tw-rounded-lg tw-border tw-border-border-weak tw-bg-background-surface-layer-01 tw-cursor-pointer hover:tw-bg-background-surface-layer-02"
                data-cy={`${app?.name?.toLowerCase().replace(/\s+/g, '-')}-card`}
              >
                <div className="tw-flex tw-flex-col tw-gap-1">
                  <span className="tw-text-text-default tw-font-medium" data-cy={`${app?.id}-name`}>
                    {decodeEntities(app?.name)}
                  </span>
                  <span className="tw-text-text-placeholder">
                    {t('workflowsDashboard.page.created', 'Created')} {moment(app?.created_at).fromNow()} ·{' '}
                    {t('workflowsDashboard.page.edited', 'Edited')} {moment(app?.updated_at).fromNow()}
                  </span>
                </div>
                <SolidIcon name="rightarrrow" width="14" fill="var(--icon-default)" />
              </div>
            ))
          )}
        </div>
      </div>
    </Layout>
  );
};

export default WorkflowsPage;
