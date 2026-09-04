import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TransactionEnvValidatorService } from './transaction-env-validator.service';

const makeConfigService = (values: Record<string, string | undefined>) => ({
  get: jest.fn((key: string) => values[key]),
});

const ALL_VARS_PRESENT = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_HORIZON_MAINNET_URL: 'https://horizon.stellar.org',
  FEATURE_MAINNET_PAYMENTS: 'true',
};

describe('TransactionEnvValidatorService', () => {
  async function buildService(
    envValues: Record<string, string | undefined>,
  ): Promise<TransactionEnvValidatorService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionEnvValidatorService,
        {
          provide: ConfigService,
          useValue: makeConfigService(envValues),
        },
      ],
    }).compile();

    return module.get<TransactionEnvValidatorService>(
      TransactionEnvValidatorService,
    );
  }

  it('should be defined', async () => {
    const service = await buildService(ALL_VARS_PRESENT);
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('does not throw when all required env vars are present', async () => {
      const service = await buildService(ALL_VARS_PRESENT);
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('throws when DATABASE_URL is missing', async () => {
      const service = await buildService({
        NODE_ENV: 'test',
        DATABASE_URL: undefined,
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
      });

      expect(() => service.onModuleInit()).toThrow(/DATABASE_URL is required/);
    });

    it('throws when STELLAR_HORIZON_URL is missing', async () => {
      const service = await buildService({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: undefined,
      });

      expect(() => service.onModuleInit()).toThrow(
        /STELLAR_HORIZON_URL is required/,
      );
    });

    it('lists all missing vars in the error message when multiple are absent', async () => {
      const service = await buildService({
        NODE_ENV: 'test',
        DATABASE_URL: undefined,
        STELLAR_HORIZON_URL: undefined,
      });

      expect(() => service.onModuleInit()).toThrow(/startup validation failed/);
    });

    it('does not throw when called multiple times with valid config', async () => {
      const service = await buildService(ALL_VARS_PRESENT);
      expect(() => {
        service.onModuleInit();
        service.onModuleInit();
      }).not.toThrow();
    });
  });

  describe('Mainnet payment validation (issue #804)', () => {
    it('allows missing STELLAR_HORIZON_MAINNET_URL in test environment', async () => {
      const service = await buildService({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: undefined,
        FEATURE_MAINNET_PAYMENTS: 'true',
      });

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('throws when STELLAR_HORIZON_MAINNET_URL is missing in production with mainnet payments enabled', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: undefined,
        FEATURE_MAINNET_PAYMENTS: 'true',
      });

      expect(() => service.onModuleInit()).toThrow(
        /FEATURE_MAINNET_PAYMENTS is enabled but STELLAR_HORIZON_MAINNET_URL is not configured/,
      );
    });

    it('throws when STELLAR_HORIZON_MAINNET_URL is empty string in production', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: '',
        FEATURE_MAINNET_PAYMENTS: 'true',
      });

      expect(() => service.onModuleInit()).toThrow(
        /FEATURE_MAINNET_PAYMENTS is enabled but STELLAR_HORIZON_MAINNET_URL is not configured/,
      );
    });

    it('throws when STELLAR_HORIZON_MAINNET_URL is invalid URL', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: 'not-a-valid-url',
        FEATURE_MAINNET_PAYMENTS: 'true',
      });

      expect(() => service.onModuleInit()).toThrow(
        /STELLAR_HORIZON_MAINNET_URL is not a valid URL/,
      );
    });

    it('allows missing STELLAR_HORIZON_MAINNET_URL when mainnet payments explicitly disabled', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: undefined,
        FEATURE_MAINNET_PAYMENTS: 'false',
      });

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('treats "FALSE" (case-insensitive) as disabled flag', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: undefined,
        FEATURE_MAINNET_PAYMENTS: 'FALSE',
      });

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('succeeds when all mainnet config is valid in production', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: 'https://horizon.stellar.org',
        FEATURE_MAINNET_PAYMENTS: 'true',
      });

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('treats any non-"false" value as enabled feature flag', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: 'https://horizon.stellar.org',
        FEATURE_MAINNET_PAYMENTS: '', // Empty string is treated as enabled
      });

      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('accepts valid https URLs for mainnet endpoint', async () => {
      const service = await buildService({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
        STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
        STELLAR_HORIZON_MAINNET_URL: 'https://custom.horizon.example.com/path',
        FEATURE_MAINNET_PAYMENTS: 'true',
      });

      expect(() => service.onModuleInit()).not.toThrow();
    });
  });
});
