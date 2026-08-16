// server/test/modules/ai/unit/service.spec.ts
import { AiService } from '@modules/ai/service';

/** @group platform */
describe('AiService.getCreditsBalance', () => {
  it('returns an enabled/unlimited result with no error, for any organization', async () => {
    const service = new AiService();

    const result = await service.getCreditsBalance('org-1');

    expect(result).toEqual({ aiFeaturesEnabled: true });
    expect(result.error).toBeUndefined();
  });

  it('does not read any credit-history repository (self-hosted CE has no credit accounting)', async () => {
    // AiService is constructed with no repositories injected at all, so there is
    // no organization_ai_credit_history / selfhost_ai_credit_history repository
    // available to touch — this call succeeding proves getCreditsBalance never
    // reaches for one.
    const service = new AiService();

    await expect(service.getCreditsBalance('org-2')).resolves.toEqual({ aiFeaturesEnabled: true });
  });
});
