import {
  TransactionEnvValidatorService,
  TRANSACTION_ENV_VALIDATOR_ERROR_CODES,
} from './transaction-env-validator.service';

describe('TransactionEnvValidatorService', () => {
  let service: TransactionEnvValidatorService;

  beforeEach(() => {
    service = new TransactionEnvValidatorService();
  });

  const validMainnetEnv = (): NodeJS.ProcessEnv => ({
    NODE_ENV: 'production',
    FEATURE_MAINNET_PAYMENTS: 'true',
    STELLAR_HORIZON_MAINNET_URL: 'https://horizon.stellar.org',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  });

  describe('validate()', () => {
    it('is valid when production mainnet payment config is complete', () => {
      const result = service.validate(validMainnetEnv());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.featureMainnetPaymentsEnabled).toBe(true);
      expect(result.mainnetHorizonUrlConfigured).toBe(true);
    });

    it('fails closed when FEATURE_MAINNET_PAYMENTS enabled but mainnet URL missing in production', () => {
      const result = service.validate({
        ...validMainnetEnv(),
        STELLAR_HORIZON_MAINNET_URL: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        TRANSACTION_ENV_VALIDATOR_ERROR_CODES.MAINNET_HORIZON_MISCONFIGURED,
      );
    });

    it('allows missing mainnet URL when the feature is explicitly disabled in production', () => {
      const result = service.validate({
        ...validMainnetEnv(),
        FEATURE_MAINNET_PAYMENTS: 'false',
        STELLAR_HORIZON_MAINNET_URL: '',
      });
      expect(result.valid).toBe(true);
    });

    it('is valid in non-production environments even with the feature enabled and URL missing', () => {
      const result = service.validate({
        ...validMainnetEnv(),
        NODE_ENV: 'test',
        STELLAR_HORIZON_MAINNET_URL: '',
      });
      expect(result.valid).toBe(true);
    });

    it('fails closed for an unrecognized flag value (deny-by-default)', () => {
      const result = service.validate({
        ...validMainnetEnv(),
        FEATURE_MAINNET_PAYMENTS: 'garbage',
        STELLAR_HORIZON_MAINNET_URL: '',
      });
      expect(result.featureMainnetPaymentsEnabled).toBe(false);
      expect(result.valid).toBe(true);
    });

    it('treats unset STELLAR_NETWORK as testnet (testnet behavior unchanged)', () => {
      const result = service.validate({ NODE_ENV: 'production' });
      expect(result.network).toBe('testnet');
      expect(result.valid).toBe(true);
    });

    it('treats a mainnet network with the flag off as warn-only, not fatal', () => {
      const result = service.validate({
        NODE_ENV: 'production',
        STELLAR_NETWORK: 'mainnet',
        FEATURE_MAINNET_PAYMENTS: 'false',
      });
      expect(result.network).toBe('mainnet');
      expect(result.valid).toBe(true);
    });

    it('also gates FEATURE_MAINNET_PAYMENT_SUBMIT (documented kill-switch)', () => {
      const result = service.validate({
        NODE_ENV: 'production',
        FEATURE_MAINNET_PAYMENT_SUBMIT: 'true',
        STELLAR_HORIZON_MAINNET_URL: '',
      });
      expect(result.featureMainnetPaymentSubmitEnabled).toBe(true);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        TRANSACTION_ENV_VALIDATOR_ERROR_CODES.MAINNET_HORIZON_MISCONFIGURED,
      );
    });

    it('never exposes secret-bearing fields in the snapshot', () => {
      const result = service.validate(validMainnetEnv());
      expect(JSON.stringify(result)).not.toMatch(/secret|key/i);
      expect(JSON.stringify(result)).not.toContain('https://');
    });
  });

  describe('onModuleInit()', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('throws out of a production boot with mainnet flag on and URL missing', async () => {
      process.env.NODE_ENV = 'production';
      process.env.FEATURE_MAINNET_PAYMENTS = 'true';
      process.env.STELLAR_HORIZON_MAINNET_URL = '';

      await expect(service.onModuleInit()).rejects.toThrow(
        'FEATURE_MAINNET_PAYMENTS is enabled but STELLAR_HORIZON_MAINNET_URL is not configured',
      );
    });

    it('resolves when production mainnet config is complete', async () => {
      process.env.NODE_ENV = 'production';
      process.env.FEATURE_MAINNET_PAYMENTS = 'true';
      process.env.STELLAR_HORIZON_MAINNET_URL = 'https://horizon.stellar.org';

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('resolves when the mainnet feature is disabled in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.FEATURE_MAINNET_PAYMENTS = 'false';
      process.env.STELLAR_HORIZON_MAINNET_URL = '';

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('resolves in test environments without a mainnet URL', async () => {
      process.env.NODE_ENV = 'test';
      process.env.FEATURE_MAINNET_PAYMENTS = 'true';
      process.env.STELLAR_HORIZON_MAINNET_URL = '';

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });
});