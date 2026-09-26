import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TransactionEnvValidatorService } from '../src/transactions/transaction-env-validator.service';

/**
 * E2E test for TransactionEnvValidatorService to verify fail-closed boot
 * when mainnet payment feature is enabled without proper Horizon configuration.
 * Tests the validator in a running NestJS application context.
 */

describe('TransactionEnvValidatorService E2E (issues #804, #914)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const baseTestnetEnv = (): void => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
  };

  async function initTransactionModule(): Promise<TestingModule> {
    const moduleRef = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [TransactionEnvValidatorService],
    });

    const module = await moduleRef.compile();
    // Instantiates the provider and runs its onModuleInit lifecycle hook.
    module.get<TransactionEnvValidatorService>(TransactionEnvValidatorService);
    return module.init();
  }

  it('should fail app startup when FEATURE_MAINNET_PAYMENTS enabled but Horizon mainnet URL missing in production', async () => {
    baseTestnetEnv();
    process.env.STELLAR_HORIZON_MAINNET_URL = ''; // Empty - will cause failure
    process.env.FEATURE_MAINNET_PAYMENTS = 'true';

    await expect(initTransactionModule()).rejects.toThrow(
      /FEATURE_MAINNET_PAYMENTS is enabled but STELLAR_HORIZON_MAINNET_URL is not configured/,
    );
  });

  it('should fail app startup when FEATURE_MAINNET_PAYMENT_SUBMIT enabled but Horizon mainnet URL missing in production', async () => {
    baseTestnetEnv();
    process.env.STELLAR_HORIZON_MAINNET_URL = '';
    process.env.FEATURE_MAINNET_PAYMENT_SUBMIT = 'true';

    await expect(initTransactionModule()).rejects.toThrow(
      /FEATURE_MAINNET_PAYMENT_SUBMIT is enabled but STELLAR_HORIZON_MAINNET_URL is not configured/,
    );
  });

  it('should succeed startup when mainnet feature explicitly disabled in production', async () => {
    baseTestnetEnv();
    process.env.STELLAR_HORIZON_MAINNET_URL = ''; // Empty but feature disabled
    process.env.FEATURE_MAINNET_PAYMENTS = 'false';

    await expect(initTransactionModule()).resolves.toBeDefined();
  });

  it('should succeed startup when all mainnet config is present', async () => {
    baseTestnetEnv();
    process.env.STELLAR_HORIZON_MAINNET_URL = 'https://horizon.stellar.org';
    process.env.FEATURE_MAINNET_PAYMENTS = 'true';

    await expect(initTransactionModule()).resolves.toBeDefined();
  });

  it('should allow missing STELLAR_HORIZON_MAINNET_URL in test environment', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_HORIZON_MAINNET_URL = '';
    process.env.FEATURE_MAINNET_PAYMENTS = 'true';

    await expect(initTransactionModule()).resolves.toBeDefined();
  });

  it('should treat an unrecognized feature value as disabled (deny-by-default, no shutdown)', async () => {
    baseTestnetEnv();
    process.env.STELLAR_HORIZON_MAINNET_URL = '';
    process.env.FEATURE_MAINNET_PAYMENTS = 'garbage';

    await expect(initTransactionModule()).resolves.toBeDefined();
  });
});