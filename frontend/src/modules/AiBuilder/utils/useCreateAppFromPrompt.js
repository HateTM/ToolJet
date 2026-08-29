import { v4 as uuidv4 } from 'uuid';
import { sample } from 'lodash';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { appsService } from '@/_services';
import { getWorkspaceId } from '@/_helpers/utils';
import posthogHelper from '@/modules/common/helpers/posthogHelper';
import configs from '@/HomePage/Configs/AppIcon.json';

const { iconList } = configs;

// Shared ADR-0010 handoff for entry points outside HomePage.jsx (e.g. /home): create the
// app with the typed prompt, then navigate into it with `state: { prompt }` for the
// builder-side useAppData hook to pick up. Mirrors HomePage.jsx's createApp behavior —
// random icon, app_created analytics, toast on failure — so entry points don't diverge.
export function useCreateAppFromPrompt() {
  const navigate = useNavigate();

  return async (name, type, prompt) => {
    try {
      const data = await appsService.createApp({
        icon: sample(iconList),
        name: name ?? `Untitled App: ${uuidv4()}`,
        type,
        prompt,
      });
      posthogHelper.captureEvent('app_created', { entry_source: prompt ? 'prompt' : 'create_button', prompt });
      navigate(`/${getWorkspaceId()}/apps/${data.id}`, { state: { prompt } });
    } catch (errorResponse) {
      toast.error(errorResponse?.error || 'Failed to create app', { style: { maxWidth: '500px' } });
    }
  };
}
