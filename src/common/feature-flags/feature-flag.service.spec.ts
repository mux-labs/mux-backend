import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeatureFlagService, FEATURE_FLAGS } from './feature-flag.service';

const makeService = async (
  env: Record<string, string>,
  nodeEnv = 'test',
): Promise<FeatureFlagService> => {
  const configGet = jest.fn((key: string) => {
    if (key === 'NODE_ENV') return nodeEnv;
    return env[key];
  });

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      FeatureFlagService,
      { provide: ConfigService, useValue: { get: configGet } },
    ],
  }).compile();

  const service = module.get<FeatureFlagService>(FeatureFlagService);
  service.onModuleInit();
  return service;
};

describe('FeatureFlagService (#965)', () => {
  describe('default behaviour (no env vars set)', () => {
    let service: FeatureFlagService;

    beforeEach(async () => {
      service = await makeService({});
    });

    it('should enable core API surfaces by default for fresh deploys', () => {
      expect(service.isEnabled('AUTH')).toBe(true);
      expect(service.isEnabled('WALLETS')).toBe(true);
      expect(service.isEnabled('PAYMENTS')).toBe(true);
      expect(service.isEnabled('WEBHOOKS')).toBe(true);
      expect(service.isEnabled('TRANSACTIONS')).toBe(true);
      expect(service.isEnabled('LIMITS')).toBe(true);
      expect(service.isEnabled('KEY_MANAGEMENT')).toBe(true);
    });

    it('should DISABLE MAINNET_PAYMENTS by default (deny-by-default #965)', () => {
      expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(false);
      expect(service.isDisabled('MAINNET_PAYMENTS')).toBe(true);
    });

    it('getAll() should report FEATURE_MAINNET_PAYMENTS as false by default', () => {
      const all = service.getAll();
      expect(all[FEATURE_FLAGS.MAINNET_PAYMENTS]).toBe(false);
      expect(all[FEATURE_FLAGS.AUTH]).toBe(true);
      expect(all[FEATURE_FLAGS.PAYMENTS]).toBe(true);
    });
  });

  describe('explicit enablement of MAINNET_PAYMENTS', () => {
    it.each(['true', 'TRUE', '1', 'yes', 'YES', 'on', 'ON'])(
      'enables MAINNET_PAYMENTS when FEATURE_MAINNET_PAYMENTS=%s',
      async (val) => {
        const service = await makeService({ FEATURE_MAINNET_PAYMENTS: val });
        expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(true);
        expect(service.isDisabled('MAINNET_PAYMENTS')).toBe(false);
      },
    );

    it.each(['false', 'FALSE', '0', 'no', 'off', 'random', '']) (
      'disables MAINNET_PAYMENTS when FEATURE_MAINNET_PAYMENTS=%s (deny-by-default)',
      async (val) => {
        const service = await makeService({ FEATURE_MAINNET_PAYMENTS: val });
        expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(false);
        expect(service.isDisabled('MAINNET_PAYMENTS')).toBe(true);
      },
    );
  });

  describe('explicit false disables core flags', () => {
    it('disables AUTH when FEATURE_AUTH=false', async () => {
      const service = await makeService({ FEATURE_AUTH: 'false' });
      expect(service.isEnabled('AUTH')).toBe(false);
      expect(service.isDisabled('AUTH')).toBe(true);
    });

    it('disables PAYMENTS when FEATURE_PAYMENTS=false', async () => {
      const service = await makeService({ FEATURE_PAYMENTS: 'false' });
      expect(service.isEnabled('PAYMENTS')).toBe(false);
      expect(service.isDisabled('PAYMENTS')).toBe(true);
    });
  });

  describe('production environment', () => {
    it('defaults MAINNET_PAYMENTS to false in production (fail-closed)', async () => {
      const service = await makeService({}, 'production');
      expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(false);
      expect(service.isDisabled('MAINNET_PAYMENTS')).toBe(true);
    });

    it('enables MAINNET_PAYMENTS in production only when explicitly set to true', async () => {
      const service = await makeService(
        { FEATURE_MAINNET_PAYMENTS: 'true' },
        'production',
      );
      expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(true);
    });
  });
});
