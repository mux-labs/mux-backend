import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletOrchestratorEnvValidatorService } from './wallet-orchestrator-env-validator.service';

const ALL_VARS_PRESENT = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_db',
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  WALLET_ENCRYPTION_KEY: 'a-secure-key-that-is-at-least-32-chars-long',
};

const makeConfigService = (values: Record<string, string | undefined>) => ({
  get: jest.fn((key: string) => values[key]),
});

async function buildService(
  envValues: Record<string, string | undefined>,
): Promise<WalletOrchestratorEnvValidatorService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      WalletOrchestratorEnvValidatorService,
      { provide: ConfigService, useValue: makeConfigService(envValues) },
    ],
  }).compile();
  return module.get(WalletOrchestratorEnvValidatorService);
}

describe('WalletOrchestratorEnvValidatorService', () => {
  it('is defined', async () => {
    const service = await buildService(ALL_VARS_PRESENT);
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('does not throw when all required vars are present and valid', async () => {
      const service = await buildService(ALL_VARS_PRESENT);
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('throws when DATABASE_URL is missing', async () => {
      const service = await buildService({ ...ALL_VARS_PRESENT, DATABASE_URL: undefined });
      expect(() => service.onModuleInit()).toThrow('DATABASE_URL');
    });

    it('throws when STELLAR_HORIZON_URL is missing', async () => {
      const service = await buildService({ ...ALL_VARS_PRESENT, STELLAR_HORIZON_URL: undefined });
      expect(() => service.onModuleInit()).toThrow('STELLAR_HORIZON_URL');
    });

    it('throws when WALLET_ENCRYPTION_KEY is missing', async () => {
      const service = await buildService({ ...ALL_VARS_PRESENT, WALLET_ENCRYPTION_KEY: undefined });
      expect(() => service.onModuleInit()).toThrow('WALLET_ENCRYPTION_KEY');
    });

    it('lists all missing vars in the error when multiple are absent', async () => {
      const service = await buildService({
        DATABASE_URL: undefined,
        STELLAR_HORIZON_URL: undefined,
        WALLET_ENCRYPTION_KEY: undefined,
      });
      expect(() => service.onModuleInit()).toThrow('DATABASE_URL');
    });

    it('throws when WALLET_ENCRYPTION_KEY is too short', async () => {
      const service = await buildService({
        ...ALL_VARS_PRESENT,
        WALLET_ENCRYPTION_KEY: 'short-key',
      });
      expect(() => service.onModuleInit()).toThrow('at least 32 characters');
    });

    it('accepts an encryption key of exactly 32 characters', async () => {
      const service = await buildService({
        ...ALL_VARS_PRESENT,
        WALLET_ENCRYPTION_KEY: '12345678901234567890123456789012', // exactly 32
      });
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('does not throw when called multiple times with valid config', async () => {
      const service = await buildService(ALL_VARS_PRESENT);
      expect(() => {
        service.onModuleInit();
        service.onModuleInit();
      }).not.toThrow();
    });
  });
});
