// Set required env vars BEFORE module import since ConfigModule.forRoot()
// validates env vars at import time (during module initialization).
process.env.DATABASE_URL = 'postgresql://localhost:5432/mux_test';
process.env.WALLET_ENCRYPTION_KEY =
  'test-key-that-is-at-least-32-characters-long!!';
process.env.STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
process.env.STELLAR_NETWORK = 'TESTNET';

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from './config.module';
import { ConfigService } from '@nestjs/config';

describe('ConfigModule', () => {
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule],
    }).compile();

    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(configService).toBeDefined();
  });

  it('should provide DATABASE_URL from env', () => {
    expect(configService.get('DATABASE_URL')).toBe(
      'postgresql://localhost:5432/mux_test',
    );
  });

  it('should provide WALLET_ENCRYPTION_KEY from env', () => {
    expect(configService.get('WALLET_ENCRYPTION_KEY')).toBe(
      'test-key-that-is-at-least-32-characters-long!!',
    );
  });

  it('should provide STELLAR_HORIZON_URL from env', () => {
    expect(configService.get('STELLAR_HORIZON_URL')).toBe(
      'https://horizon-testnet.stellar.org',
    );
  });

  it('should provide default values for optional config', () => {
    expect(configService.get('PORT')).toBe(3000);
    expect(configService.get('RATE_LIMIT_WINDOW_MS')).toBe(60000);
    expect(configService.get('RATE_LIMIT_MAX_REQUESTS')).toBe(100);
  });
});
