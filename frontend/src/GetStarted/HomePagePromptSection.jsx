import React from 'react';

import CreateAppWithPrompt from '@/modules/AiBuilder/components/CreateAppWithPrompt';
import { useCreateAppFromPrompt } from '@/modules/AiBuilder/utils/useCreateAppFromPrompt';
import { withEditionSpecificComponent } from '@/modules/common/helpers/withEditionSpecificComponent';

// /home entry point: the AI prompt bar above the "OR START WITH" cards. Uses the home
// variant (rotating Tab-to-accept placeholder) — the apps-list variant with a static
// placeholder + example chips is rendered by HomePage.jsx directly. The createApp
// handoff is the shared ADR-0010 one (useCreateAppFromPrompt).
const HomePagePromptSection = () => {
  const createApp = useCreateAppFromPrompt();

  return (
    <div className="tw-w-full" data-cy="home-page-prompt-section">
      <CreateAppWithPrompt createApp={createApp} variant="home" />
    </div>
  );
};

export default withEditionSpecificComponent(HomePagePromptSection, 'AiBuilder');
