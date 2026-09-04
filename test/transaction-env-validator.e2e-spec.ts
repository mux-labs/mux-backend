import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Module, NestModule } from '@nestjs/common';
import { TransactionEnvValidatorService } from '../src/transactions/transaction-env-validator.service';

/**
 * E2E test for TransactionEnvValidatorService to verify fail-closed boot
 * when mainnet payment feature is enabled without proper Horizon configuration.
 * Tests the validator in a running NestJS application context.
 */

describe('TransactionEnvValidatorService E2E (issue #804)', () => {
  @Module({
    imports: [ConfigModule.forRoot()],
    providers: [TransactionEnvValidatorService],
  })
  class TestTransactionModule implements NestModule {
    configure() {}
  }

  it('should fail app startup when FEATURE_MAINNET_PAYMENTS enabled but Horizon mainnet URL missing in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_HORIZON_MAINNET_URL = ''; // Empty - will cause failure
    process.env.FEATURE_MAINNET_PAYMENTS = 'true';

    const moduleRef = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [TransactionEnvValidatorService],
    });

    await expect(
      moduleRef.compile().then((module) => {
        // Get the service to trigger onModuleInit
        module.get<TransactionEnvValidatorService>(TransactionEnvValidatorService);
        return module.init();
      }),
    ).rejects.toThrow(
      /FEATURE_MAINNET_PAYMENTS is enabled but STELLAR_HORIZON_MAINNET_URL is not configured/,
    );

    // Cleanup
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_HORIZON_MAINNET_URL;
    delete process.env.FEATURE_MAINNET_PAYMENTS;
  });

  it('should succeed startup when mainnet feature explicitly disabled in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_HORIZON_MAINNET_URL = ''; // Empty but feature disabled
    process.env.FEATURE_MAINNET_PAYMENTS = 'false';

    const moduleRef = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [TransactionEnvValidatorService],
    });

    const module = await moduleRef.compile();
    expect(() => {
      module.get<TransactionEnvValidatorService>(TransactionEnvValidatorService);
    }).not.toThrow();

    // Cleanup
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_HORIZON_MAINNET_URL;
    delete process.env.FEATURE_MAINNET_PAYMENTS;
  });

  it('should succeed startup when all mainnet config is present', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_HORIZON_MAINNET_URL = 'https://horizon.stellar.org';
    process.env.FEATURE_MAINNET_PAYMENTS = 'true';

    const moduleRef = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [TransactionEnvValidatorService],
    });

    const module = await moduleRef.compile();
    expect(() => {
      module.get<TransactionEnvValidatorService>(TransactionEnvValidatorService);
    }).not.toThrow();

    // Cleanup
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_HORIZON_MAINNET_URL;
    delete process.env.FEATURE_MAINNET_PAYMENTS;
  });

  it('should allow missing STELLAR_HORIZON_MAINNET_URL in test environment', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgresql://localhost/test';
    process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.STELLAR_HORIZON_MAINNET_URL = '';
    process.env.FEATURE_MAINNET_PAYMENTS = 'true';

    const moduleRef = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [TransactionEnvValidatorService],
    });

    const module = await moduleRef.compile();
    expect(() => {
      module.get<TransactionEnvValidatorService>(TransactionEnvValidatorService);
    }).not.toThrow();

    // Cleanup
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    delete process.env.STELLAR_HORIZON_URL;
    delete process.env.STELLAR_HORIZON_MAINNET_URL;
    delete process.env.FEATURE_MAINNET_PAYMENTS;
  });
});
