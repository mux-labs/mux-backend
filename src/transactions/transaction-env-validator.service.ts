import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const REQUIRED_VARS: ReadonlyArray<string> = [
  'DATABASE_URL',
  'STELLAR_HORIZON_URL',
];

/**
 * Environment validator for transactions module.
 *
 * Enforces fail-closed behavior:
 *   - In dev/test: missing vars are warnings; feature flags default to enabled
 *   - In production: missing required vars fail immediately at startup
 *   - In production: if FEATURE_MAINNET_PAYMENTS is enabled, Horizon mainnet
 *     URL must be configured (fail at startup, not at payment submission time)
 */
@Injectable()
export class TransactionEnvValidatorService implements OnModuleInit {
  private readonly logger = new Logger(TransactionEnvValidatorService.name);
  private readonly isProduction: boolean;

  constructor(private readonly configService: ConfigService) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  onModuleInit(): void {
    const missing: string[] = [];
    const violations: string[] = [];

    // Check required vars
    for (const key of REQUIRED_VARS) {
      const value = this.configService.get<string>(key);
      if (!value || value.trim().length === 0) {
        missing.push(key);
      }
    }

    // In production, validate mainnet payment configuration
    if (this.isProduction) {
      const mainnetPaymentsEnabled = this.isFeatureFlagEnabled('FEATURE_MAINNET_PAYMENTS');
      if (mainnetPaymentsEnabled) {
        // If mainnet payments are enabled, Horizon mainnet URL must be configured
        const horizonMainnetUrl = this.configService.get<string>('STELLAR_HORIZON_MAINNET_URL');
        if (!horizonMainnetUrl || horizonMainnetUrl.trim().length === 0) {
          violations.push(
            'FEATURE_MAINNET_PAYMENTS is enabled but STELLAR_HORIZON_MAINNET_URL is not configured. ' +
            'Mainnet fee-bump transactions cannot be submitted without a valid Horizon mainnet endpoint.',
          );
        }

        // Also validate that it's a valid URL
        try {
          new URL(horizonMainnetUrl || '');
        } catch {
          violations.push(
            `STELLAR_HORIZON_MAINNET_URL is not a valid URL: "${horizonMainnetUrl}"`,
          );
        }
      }
    }

    // Fail if any violations found
    if (missing.length > 0 || violations.length > 0) {
      const allIssues = [
        ...missing.map((m) => `${m} is required`),
        ...violations,
      ];
      const msg = `Transactions API startup validation failed:\n  - ${allIssues.join('\n  - ')}`;
      this.logger.error(msg);
      throw new Error(msg);
    }

    this.logger.log('Transactions API environment validated successfully');
  }

  /**
   * Check if a feature flag is enabled.
   * In production, only explicitly "false" disables a flag.
   * Otherwise defaults to enabled (safe for fresh deploys).
   */
  private isFeatureFlagEnabled(flagName: string): boolean {
    const raw = this.configService.get<string>(flagName);
    if (raw !== undefined && raw !== null && raw.trim().toLowerCase() === 'false') {
      return false;
    }
    return true;
  }
}
