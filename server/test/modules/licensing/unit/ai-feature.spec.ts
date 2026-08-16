// server/test/modules/licensing/unit/ai-feature.spec.ts
import License from '@modules/licensing/configs/License';
import { BASIC_PLAN_TERMS } from '@modules/licensing/constants/PlanTerms';
import { LICENSE_FIELD } from '@modules/licensing/constants';
import { getLicenseFieldValue } from '@modules/licensing/helper';

/**
 * `LicenseBase` shortcuts to "everything enabled" when NODE_ENV === 'test' and
 * no licenseData is passed (see LicenseBase constructor), which is how the
 * rest of the suite normally runs. That shortcut would mask a real regression
 * in BASIC_PLAN_TERMS, so these tests force NODE_ENV away from 'test' for the
 * duration of construction, to exercise the actual CE (basic-plan) code path:
 * `License` (CE) -> `super(BASIC_PLAN_TERMS)` with no licenseData -> IsBasicPlan
 * -> `aiFeature` reads `BASIC_PLAN_TERMS.features.ai`.
 */
/** @group platform */
describe('CE licensing: ai feature gate', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  const buildCeLicense = () => {
    process.env.NODE_ENV = 'production';
    try {
      return License.Reload('', new Date());
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  };

  it('BASIC_PLAN_TERMS.features.ai is true', () => {
    expect(BASIC_PLAN_TERMS.features.ai).toBe(true);
  });

  it('resolves aiFeature to true on the CE (basic plan) license', () => {
    const license = buildCeLicense();

    expect(license.aiFeature).toBe(true);
  });

  it('resolves LICENSE_FIELD.AI_FEATURE to true via getLicenseFieldValue on the CE license', () => {
    const license = buildCeLicense();

    expect(getLicenseFieldValue(LICENSE_FIELD.AI_FEATURE, license)).toBe(true);
  });

  it('does not change any other BASIC_PLAN_TERMS.features flag', () => {
    expect(BASIC_PLAN_TERMS.features).toEqual({
      auditLogs: false,
      oidc: false,
      saml: false,
      customStyling: false,
      ldap: false,
      whiteLabelling: false,
      multiEnvironment: false,
      multiPlayerEdit: false,
      gitSync: false,
      comments: false,
      customThemes: false,
      serverSideGlobalResolve: false,
      queryFolders: false,
      scim: false,
      observability: false,
      ai: true,
    });
  });
});
