import { FEATURE_KEY } from '../constants';
import { FeatureConfig } from '@modules/app/types';
import { MODULES } from '@modules/app/constants/modules';

interface Features {
  [FEATURE_KEY.PING]: FeatureConfig;
  [FEATURE_KEY.FETCH_ZERO_STATE]: FeatureConfig;
  [FEATURE_KEY.SEND_USER_MESSAGE]: FeatureConfig;
  [FEATURE_KEY.SEND_DOCS_MESSAGE]: FeatureConfig;
  [FEATURE_KEY.PROMOTE_CONVERSATION]: FeatureConfig;
  [FEATURE_KEY.APPROVE_PRD]: FeatureConfig;
  [FEATURE_KEY.REWIND_STEP]: FeatureConfig;
  [FEATURE_KEY.SKIP_STEP]: FeatureConfig;
  [FEATURE_KEY.CONFIRM_STEP]: FeatureConfig;
  [FEATURE_KEY.REGENERATE_MESSAGE]: FeatureConfig;
  [FEATURE_KEY.VOTE_MESSAGE]: FeatureConfig;
  [FEATURE_KEY.FIX_WITH_AI]: FeatureConfig;
  [FEATURE_KEY.COPILOT]: FeatureConfig;
  [FEATURE_KEY.GET_CREDITS_BALANCE]: FeatureConfig;
  [FEATURE_KEY.LIST_CONVERSATIONS]: FeatureConfig;
  [FEATURE_KEY.CREATE_CONVERSATION]: FeatureConfig;
  [FEATURE_KEY.GET_CONVERSATION]: FeatureConfig;
  [FEATURE_KEY.UPDATE_KEY]: FeatureConfig;
  [FEATURE_KEY.GET_KEY_SETTINGS]: FeatureConfig;
  [FEATURE_KEY.AUTO_SORT_QUERIES]: FeatureConfig;
  [FEATURE_KEY.GET_THREAD_TOKEN_USAGE]: FeatureConfig;
  [FEATURE_KEY.GET_ACTIVE_RUN]: FeatureConfig;
}

export interface FeaturesConfig {
  [MODULES.AI]: Features;
}

/**
 * CONTEXT.md's `Error context`: everything a `Fix with AI` request carries about one failing
 * component property. Only the expression and the error are required — they are what make the
 * fix determinable; the rest is labelling that improves the answer when the client has it.
 */
export interface ErrorContext {
  expression: string;
  errorMessage: string;
  componentName?: string;
  componentType?: string;
  propertyName?: string;
  fallbackValue?: any;
}

/** CONTEXT.md's `Suggestion`: the single proposed replacement one request produces. */
export interface Suggestion {
  fixedValue: string;
  explanation: string;
}

/**
 * CONTEXT.md's `Copilot context`: everything a `Copilot` request carries. Only the prompt is
 * required — it is the request. `appId` is optional because an ungrounded completion is worth
 * more than a rejection (ADR-0016), and the rest describes the editor being written into.
 */
export interface CopilotContext {
  prompt: string;
  currentCode?: string;
  language?: string;
  dataSourceKind?: string;
  appId?: string;
}

/** CONTEXT.md's `Completion`: the whole replacement editor body one request produces. */
export interface Completion {
  code: string;
  explanation: string;
}
