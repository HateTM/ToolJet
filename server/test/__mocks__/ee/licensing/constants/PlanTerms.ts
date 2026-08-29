// server/test/__mocks__/ee/licensing/constants/PlanTerms.ts
//
// CE-fork stand-in for the EE cloud plan terms. test/helpers/setup.ts maps the
// team/starter/pro plans to these EE terms; in a CE-only fork (server/ee is an unpopulated
// private submodule) the honest fallback is the CE base plan terms — the same defaults the
// CE licensing code falls back to when no EE license is present.
export { BASIC_PLAN_TERMS, BUSINESS_PLAN_TERMS, ENTERPRISE_PLAN_TERMS } from '@modules/licensing/constants/PlanTerms';

export const STARTER_PLAN_TERMS_CLOUD = undefined;
export const PRO_PLAN_TERMS_CLOUD = undefined;
export const TEAM_PLAN_TERMS_CLOUD = undefined;
