import React, { useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { appsService } from '@/_services';
import { getWorkspaceId } from '@/_helpers/utils';
import CreateAppWithPrompt from '@/modules/AiBuilder/components/CreateAppWithPrompt';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';

// /home entry point: the AI prompt bar above the "OR START WITH" cards. Uses the home
// variant (rotating Tab-to-accept placeholder) — the apps-list variant with a static
// placeholder + example chips is rendered by HomePage.jsx directly.
// The createApp handoff mirrors HomePage.jsx's (ADR-0010): create the app, navigate
// into it with `state: { prompt }` for the builder-side useAppData hook to pick up.
const HomePagePromptSection = () => {
  const navigate = useNavigate();

  const createApp = useCallback(
    async (name, _type, prompt) => {
      try {
        const data = await appsService.createApp({
          name: name ?? `Untitled App: ${uuidv4()}`,
          type: 'front-end',
          prompt,
        });
        navigate(`/${getWorkspaceId()}/apps/${data.id}`, { state: { prompt } });
      } catch (error) {
        toast.error(error?.error || 'Failed to create app', { style: { maxWidth: '500px' } });
      }
    },
    [navigate]
  );

  return (
    <div className="tw-w-full" data-cy="home-page-prompt-section">
      <CreateAppWithPrompt createApp={createApp} variant="home" />
    </div>
  );
};

export default withEditionSpecificComponent(HomePagePromptSection, 'AiBuilder');
