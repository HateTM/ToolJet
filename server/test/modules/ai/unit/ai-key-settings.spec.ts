// server/test/modules/ai/unit/ai-key-settings.spec.ts
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AiKeySettingsService } from '@modules/ai/services/ai-key-settings.service';

const buildMockRepository = () => ({
  findByOrganizationId: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((value: any) => ({ ...value })),
  save: jest.fn(),
});

const buildMockEncryption = () => ({
  encryptColumnValue: jest.fn().mockImplementation(async (_t: string, _c: string, plain: string) => `enc(${plain})`),
  decryptColumnValue: jest
    .fn()
    .mockImplementation(async (_t: string, _c: string, cipher: string) =>
      cipher.replace(/^enc\(/, '').replace(/\)$/, '')
    ),
});

const adminPermissions = { isAdmin: true, isSuperAdmin: false } as any;
const memberPermissions = { isAdmin: false, isSuperAdmin: false } as any;
const buildUser = (organizationId = 'org-1') => ({ id: 'user-1', organizationId }) as any;

const buildService = (repo = buildMockRepository(), encryption = buildMockEncryption()) => ({
  repo,
  encryption,
  service: new AiKeySettingsService(repo as any, encryption as any),
});

/** @group platform */
describe('AiKeySettingsService (ticket #59)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('admin gating', () => {
    it.each([
      ['member', memberPermissions],
      ['missing permissions', undefined],
    ])('rejects getKeySettings for a non-admin (%s)', async (_name, permissions) => {
      const { service } = buildService();
      await expect(service.getKeySettings(buildUser(), permissions as any)).rejects.toThrow(ForbiddenException);
    });

    it('rejects updateKey for a non-admin', async () => {
      const { service } = buildService();
      await expect(
        service.updateKey(buildUser(), memberPermissions, { provider: 'anthropic', apiKey: 'sk-ant-12345678' } as any)
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows an admin', async () => {
      const { service } = buildService();
      await expect(service.getKeySettings(buildUser(), adminPermissions)).resolves.toMatchObject({ hasKey: false });
    });
  });

  describe('updateKey', () => {
    it('encrypts the key through EncryptionService with the entity table/column pair', async () => {
      const { service, encryption, repo } = buildService();
      await service.updateKey(buildUser(), adminPermissions, {
        provider: 'anthropic',
        apiKey: 'sk-ant-12345678',
        model: 'claude-sonnet-4',
      } as any);

      expect(encryption.encryptColumnValue).toHaveBeenCalledWith(
        'organization_ai_keys',
        'encrypted_key',
        'sk-ant-12345678'
      );
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4' })
      );
    });

    it('rejects a first-time configuration without an apiKey', async () => {
      const { service } = buildService();
      await expect(service.updateKey(buildUser(), adminPermissions, { provider: 'openai' } as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it('keeps the stored key when only the model changes', async () => {
      const { service, encryption, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        encryptedKey: 'enc(sk-ant-12345678)',
        contextWindow: null,
        useEnvironmentConfig: false,
      });

      await service.updateKey(buildUser(), adminPermissions, { provider: 'anthropic', model: 'claude-opus-4' } as any);

      expect(encryption.encryptColumnValue).not.toHaveBeenCalled();
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-4' }));
    });

    it('requires a new apiKey when switching providers', async () => {
      const { service, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        encryptedKey: 'enc(sk-ant-12345678)',
        contextWindow: null,
        useEnvironmentConfig: false,
      });

      await expect(
        service.updateKey(buildUser(), adminPermissions, { provider: 'openai', model: 'gpt-4o' } as any)
      ).rejects.toThrow(/apiKey is required when switching providers/);
    });

    it('rejects a provider outside the supported list', async () => {
      const { service, repo } = buildService();
      await expect(
        service.updateKey(buildUser(), adminPermissions, {
          provider: 'not-a-provider',
          apiKey: 'sk-ant-12345678',
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('masking and effective config', () => {
    it('never exposes the key: settings carry only a masked placeholder', async () => {
      const { service, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'openai',
        model: 'gpt-4o',
        encryptedKey: 'enc(sk-xxx)',
        contextWindow: 128000,
        useEnvironmentConfig: false,
      });

      const settings = await service.getKeySettings(buildUser(), adminPermissions);

      expect(settings).toEqual({
        provider: 'openai',
        model: 'gpt-4o',
        contextWindow: 128000,
        useEnvironmentConfig: false,
        hasKey: true,
        maskedApiKey: '••••••••',
      });
      expect(JSON.stringify(settings)).not.toContain('enc(sk-xxx)');
    });

    it('returns null effective config when useEnvironmentConfig is set', async () => {
      const { service, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'openai',
        model: 'gpt-4o',
        encryptedKey: 'enc(sk-xxx)',
        contextWindow: null,
        useEnvironmentConfig: true,
      });

      await expect(service.getEffectiveOrgConfig('org-1')).resolves.toBeNull();
    });

    it('decrypts the stored key and returns the org config with the provider window fallback', async () => {
      const { service, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'grok',
        model: 'grok-4',
        encryptedKey: 'enc(sk-xai)',
        contextWindow: null,
        useEnvironmentConfig: false,
      });

      const config = await service.getEffectiveOrgConfig('org-1');

      expect(config).toMatchObject({ source: 'org', provider: 'grok', model: 'grok-4', apiKey: 'sk-xai' });
      expect(config.contextWindow).toBe(500000);
    });

    it('falls back to env when the org config has no model yet (incomplete config)', async () => {
      const { service, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'anthropic',
        model: null,
        encryptedKey: 'enc(sk-ant-12345678)',
        contextWindow: null,
        useEnvironmentConfig: false,
      });

      await expect(service.getEffectiveOrgConfig('org-1')).resolves.toBeNull();
    });

    it('treats tooljet_managed as no org config (EE credits intentionally not ported)', async () => {
      const { service, repo } = buildService();
      repo.findByOrganizationId.mockResolvedValue({
        organizationId: 'org-1',
        provider: 'tooljet_managed',
        model: null,
        encryptedKey: 'enc(sk-xxx)',
        contextWindow: null,
        useEnvironmentConfig: false,
      });

      await expect(service.getEffectiveOrgConfig('org-1')).resolves.toBeNull();
    });
  });
});
