import { getSubpath } from '@/_helpers/routes';
import { isString } from 'lodash';
import config from 'config';

const processErrorMessage = (error) => {
  if (isString(error)) {
    return error;
  }
  return error?.error || 'Something went wrong. Please try again.';
};

function clearPageHistory() {
  const subpath = getSubpath() || '';
  history.replaceState(null, null, `${subpath}/`);
}

const fetchEdition = () => {
  return config.TOOLJET_EDITION?.toLowerCase() || 'ce';
};

const isWorkflowsFeatureEnabled = () => {
  /* ADR-0047: Workflows ship fully in CE — no edition or license gating. */
  return true;
};

export { processErrorMessage, clearPageHistory, fetchEdition, isWorkflowsFeatureEnabled };
