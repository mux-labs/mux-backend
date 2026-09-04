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
  // Manually trigger lifecycle hook (Testing module does not auto-call it)
  service.onModuleInit();
  return service;
};

describe('FeatureFlagService', () => {
  describe('default behaviour (no env vars set)', () => {
    let service: FeatureFlagService;

    beforeEach(async () => {
      service = await makeService({});
    });

    it('should enable AUTH by default', () => {
      expect(service.isEnabled('AUTH')).toBe(true);
    });

    it('should enable WALLETS by default', () => {
      expect(service.isEnabled('WALLETS')).toBe(true);
    });

    it('should enable PAYMENTS by default', () => {
      expect(service.isEnabled('PAYMENTS')).toBe(true);
    });

    it('should enable WEBHOOKS by default', () => {
      expect(service.isEnabled('WEBHOOKS')).toBe(true);
    });

    it('should enable TRANSACTIONS by default', () => {
      expect(service.isEnabled('TRANSACTIONS')).toBe(true);
    });

    it('should enable LIMITS by default', () => {
      expect(service.isEnabled('LIMITS')).toBe(true);
    });

    it('should enable KEY_MANAGEMENT by default', () => {
      expect(service.isEnabled('KEY_MANAGEMENT')).toBe(true);
    });

    it('should enable MAINNET_PAYMENTS by default', () => {
      expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(true);
    });

    it('isDisabled should return false for all flags by default', () => {
      for (const key of Object.keys(FEATURE_FLAGS) as Array<keyof typeof FEATURE_FLAGS>) {
        expect(service.isDisabled(key)).toBe(false);
      }
    });
  });

  describe('explicit false disables a flag', () => {
    it('disables AUTH when FEATURE_AUTH=false', async () => {
      const service = await makeService({ FEATURE_AUTH: 'false' });
      expect(service.isEnabled('AUTH')).toBe(false);
      expect(service.isDisabled('AUTH')).toBe(true);
    });

    it('disables AUTH when FEATURE_AUTH=FALSE (case insensitive)', async () => {
      const service = await makeService({ FEATURE_AUTH: 'FALSE' });
      expect(service.isEnabled('AUTH')).toBe(false);
    });

    it('disables WALLETS when FEATURE_WALLETS=false', async () => {
      const service = await makeService({ FEATURE_WALLETS: 'false' });
      expect(service.isEnabled('WALLETS')).toBe(false);
    });

    it('disables PAYMENTS when FEATURE_PAYMENTS=false', async () => {
      const service = await makeService({ FEATURE_PAYMENTS: 'false' });
      expect(service.isEnabled('PAYMENTS')).toBe(false);
    });

    it('disables WEBHOOKS when FEATURE_WEBHOOKS=false', async () => {
      const service = await makeService({ FEATURE_WEBHOOKS: 'false' });
      expect(service.isEnabled('WEBHOOKS')).toBe(false);
    });

    it('disables MAINNET_PAYMENTS when FEATURE_MAINNET_PAYMENTS=false', async () => {
      const service = await makeService({ FEATURE_MAINNET_PAYMENTS: 'false' });
      expect(service.isEnabled('MAINNET_PAYMENTS')).toBe(false);
    });
  });

  describe('non-false values keep a flag enabled', () => {
    it('keeps AUTH enabled when FEATURE_AUTH=true', async () => {
      const service = await makeService({ FEATURE_AUTH: 'true' });
      expect(service.isEnabled('AUTH')).toBe(true);
    });

    it('keeps AUTH enabled when FEATURE_AUTH=1', async () => {
      const service = await makeService({ FEATURE_AUTH: '1' });
      expect(service.isEnabled('AUTH')).toBe(true);
    });

    it('keeps AUTH enabled when FEATURE_AUTH=yes', async () => {
      const service = await makeService({ FEATURE_AUTH: 'yes' });
      expect(service.isEnabled('AUTH')).toBe(true);
    });
  });

  describe('production environment', () => {
    it('still enables all flags by default in production', async () => {
      const service = await makeService({}, 'production');
      for (const key of Object.keys(FEATURE_FLAGS) as Array<keyof typeof FEATURE_FLAGS>) {
        expect(service.isEnabled(key)).toBe(true);
      }
    });

    it('disables flag in production when explicitly false', async () => {
      const service = await makeService({ FEATURE_AUTH: 'false' }, 'production');
      expect(service.isEnabled('AUTH')).toBe(false);
    });

    it('does not silently mock or enable a disabled flag in production', async () => {
      const service = await makeService(
        { FEATURE_WALLETS: 'false' },
        'production',
      );
      // The service must report the flag as disabled — no silent override
      expect(service.isDisabled('WALLETS')).toBe(true);
    });
  });

  describe('getAll()', () => {
    it('returns a map of all env var names to booleans', async () => {
      const service = await makeService({ FEATURE_PAYMENTS: 'false' });
      const all = service.getAll();

      expect(all[FEATURE_FLAGS.AUTH]).toBe(true);
      expect(all[FEATURE_FLAGS.WALLETS]).toBe(true);
      expect(all[FEATURE_FLAGS.PAYMENTS]).toBe(false);
      expect(all[FEATURE_FLAGS.WEBHOOKS]).toBe(true);
      expect(all[FEATURE_FLAGS.TRANSACTIONS]).toBe(true);
      expect(all[FEATURE_FLAGS.LIMITS]).toBe(true);
      expect(all[FEATURE_FLAGS.KEY_MANAGEMENT]).toBe(true);
      expect(all[FEATURE_FLAGS.MAINNET_PAYMENTS]).toBe(true);
    });

    it('returns all flags as true when nothing is disabled', async () => {
      const service = await makeService({});
      const all = service.getAll();
      for (const val of Object.values(all)) {
        expect(val).toBe(true);
      }
    });
import { ConfigService } from '@nestjs/config';
import { FeatureFlagService } from './feature-flag.service';

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: jest.fn(),
    } as any;

    service = new FeatureFlagService(configService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return true when feature flag is enabled', () => {
    jest.spyOn(configService, 'get').mockReturnValue('true');

    const result = service.isEnabled('transactions_api');

    expect(result).toBe(true);
    expect(configService.get).toHaveBeenCalledWith('FEATURE_TRANSACTIONS_API');
  });

  it('should return false when feature flag is disabled', () => {
    jest.spyOn(configService, 'get').mockReturnValue('false');

    const result = service.isEnabled('transactions_api');

    expect(result).toBe(false);
  });

  it('should return false when feature flag is not set', () => {
    jest.spyOn(configService, 'get').mockReturnValue(undefined);

    const result = service.isEnabled('transactions_api');

    expect(result).toBe(false);
  });

  it('should handle case-insensitive values', () => {
    jest.spyOn(configService, 'get').mockReturnValue('TRUE');

    const result = service.isEnabled('test_flag');

    expect(result).toBe(true);
  });

  it('should handle lowercase true values', () => {
    jest.spyOn(configService, 'get').mockReturnValue('true');

    const result = service.isEnabled('test_flag');

    expect(result).toBe(true);
  });

  it('should convert flag name to uppercase env var', () => {
    jest.spyOn(configService, 'get').mockReturnValue('true');

    service.isEnabled('my_feature_flag');

    expect(configService.get).toHaveBeenCalledWith('FEATURE_MY_FEATURE_FLAG');
  });
});
