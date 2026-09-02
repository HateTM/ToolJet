import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import cx from 'classnames';
import moment from 'moment';
import { toast } from 'react-hot-toast';
import { appsService, appVersionService } from '@/_services';
import { getPrivateRoute } from '@/_helpers/routes';
import { processErrorMessage } from '@/modules/common/helpers/utils';
import { ToolTip } from '@/_components';
import SolidIcon from '@/_ui/Icon/SolidIcons';

/* WP-1 skeleton (ADR-0047): header, placeholder canvas area and the version list.
   The actual reactflow canvas and editing capabilities arrive in WP-4. */
const WorkflowEditorPage = ({ id, slug, darkMode }) => {
  const { t } = useTranslation();
  const [app, setApp] = useState(null);
  const [versions, setVersions] = useState([]);

  useEffect(() => {
    if (!id) return;
    appsService
      .getApp(id)
      .then((data) => setApp(data))
      .catch((error) => toast.error(processErrorMessage(error), { style: { maxWidth: '400px' } }));

    appVersionService
      .getAll(id)
      .then((data) => setVersions(data?.versions ?? []))
      .catch((error) => toast.error(processErrorMessage(error), { style: { maxWidth: '400px' } }));
  }, [id]);

  return (
    <div
      className={cx('tw-flex tw-flex-col tw-h-screen tw-w-full tw-bg-background-surface-layer-01', {
        'dark-theme theme-dark': darkMode,
      })}
    >
      <header className="tw-flex tw-items-center tw-justify-between tw-px-4 tw-py-2.5 tw-border-b tw-border-border-weak">
        <div className="tw-flex tw-items-center tw-gap-2">
          <ToolTip message={t('workflowsDashboard.editor.backToWorkflows', 'Back to workflows')}>
            <Link
              to={getPrivateRoute('workflows')}
              className="tw-flex tw-items-center tw-cursor-pointer"
              data-cy="workflow-editor-back-button"
            >
              <SolidIcon name="leftarrow" width="14" fill="var(--icon-default)" />
            </Link>
          </ToolTip>
          <span className="tw-text-text-default tw-font-medium" data-cy="workflow-editor-app-name">
            {app?.name || slug}
          </span>
        </div>
      </header>
      <div className="tw-flex tw-flex-1 tw-min-h-0">
        <main className="tw-flex tw-flex-1 tw-items-center tw-justify-center">
          <p className="tw-text-text-placeholder" data-cy="workflow-canvas-placeholder">
            {t(
              'workflowsDashboard.editor.canvasComingSoon',
              'The workflow canvas is under construction and will be available in an upcoming release.'
            )}
          </p>
        </main>
        <aside className="tw-flex tw-flex-col tw-gap-2 tw-w-60 tw-px-4 tw-py-3 tw-border-l tw-border-border-weak">
          <h3 className="tw-text-text-default" data-cy="workflow-versions-label">
            {t('workflowsDashboard.editor.versions', 'Versions')}
          </h3>
          {versions.length === 0 ? (
            <p className="tw-text-text-placeholder" data-cy="no-versions-message">
              {t('workflowsDashboard.editor.noVersions', 'No versions yet')}
            </p>
          ) : (
            versions.map((version) => (
              <div key={version?.id} className="tw-flex tw-flex-col" data-cy={`${version?.name}-version-item`}>
                <span className="tw-text-text-default">{version?.name}</span>
                <span className="tw-text-text-placeholder">
                  {t('workflowsDashboard.page.created', 'Created')} {moment(version?.created_at).fromNow()}
                </span>
              </div>
            ))
          )}
        </aside>
      </div>
    </div>
  );
};

export default WorkflowEditorPage;
