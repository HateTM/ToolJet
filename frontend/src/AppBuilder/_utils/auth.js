import { authenticationService } from '@/_services/authentication.service';
import { setCookie } from '@/_helpers/cookie';
import { sessionService } from '@/_services';
import { unregisterBranchFocusSync } from '@/_helpers/active-branch';

export function fetchOAuthToken(authUrl, dataSourceId) {
  localStorage.setItem('sourceWaitingForOAuth', dataSourceId);
  const currentSessionValue = authenticationService.currentSessionValue;
  currentSessionValue?.current_organization_id &&
    setCookie('orgIdForOauth', currentSessionValue?.current_organization_id);
  window.open(authUrl);
}

export function logoutAction() {
  unregisterBranchFocusSync();
  localStorage.clear();
  sessionStorage.clear();
  sessionService.logout(false);

  return Promise.resolve();
}

export function fetchOauthTokenForSlackAndGSheet(dataSourceId, data) {
  const provider = data?.kind;
  let scope = '';
  let authUrl = data.auth_url;

  switch (provider) {
    case 'zendesk': {
      scope = data?.options?.access_type === 'read' ? 'read' : 'read%20write';
      authUrl = `${authUrl}&scope=${scope}`;
      break;
    }
    default:
      break;
  }

  localStorage.setItem('sourceWaitingForOAuth', dataSourceId);
  window.open(authUrl);
}
