import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const REQUIRED_VARS: ReadonlyArray<string> = [
  'DATABASE_URL',
  'STELLAR_HORIZON_URL',
  'WALLET_ENCRYPTION_KEY',
];

const MIN_ENCRYPTION_KEY_LENGTH = 32;

@Injectable()
export class WalletOrchestratorEnvValidatorService implements OnModuleInit {
  private readonly logger = new Logger(WalletOrchestratorEnvValidatorService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const missing: string[] = [];

    for (const key of REQUIRED_VARS) {
      const value = this.configService.get<string>(key);
      if (!value) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      const msg = `Wallet orchestrator is missing required environment variables: ${missing.join(', ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    // Additional constraint: WALLET_ENCRYPTION_KEY must be long enough
    const encKey = this.configService.get<string>('WALLET_ENCRYPTION_KEY')!;
    if (encKey.length < MIN_ENCRYPTION_KEY_LENGTH) {
      const msg = `WALLET_ENCRYPTION_KEY must be at least ${MIN_ENCRYPTION_KEY_LENGTH} characters (got ${encKey.length})`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.logger.log('Wallet orchestrator environment validated successfully');
  }
}
