import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * All recognized FEATURE_* environment variable names.
 * These gate the core API surfaces of Mux Backend.
 * Core API flags default to ENABLED when unset so a fresh deploy serves core
 * APIs out of the box. A core flag must be explicitly set to "false" to disable.
 *
 * Money-path and mainnet-affecting flags (FEATURE_MAINNET_PAYMENTS) are
 * DENY-BY-DEFAULT: they default to DISABLED (false) unless explicitly enabled
 * with a truthy token ('true', '1', 'yes', 'on') per docs/MAINNET-PAYMENT-FEATURE-FLAG.md (#965).
 *
 * NEVER silently mock or bypass a flag in production — if a flag is false in
 * production the corresponding API must return 503 / 404 rather than pretend
 * to work.
 */
export const FEATURE_FLAGS = {
  /** Enable the /v1/auth/** authentication & onboarding endpoints */
  AUTH: 'FEATURE_AUTH',
  /** Enable the /v1/wallets/** wallet management endpoints */
  WALLETS: 'FEATURE_WALLETS',
  /** Enable the /v1/payments/** payment endpoints */
  PAYMENTS: 'FEATURE_PAYMENTS',
  /** Enable the /v1/webhooks/** webhook management endpoints */
  WEBHOOKS: 'FEATURE_WEBHOOKS',
  /** Enable the /v1/transactions/** transaction endpoints */
  TRANSACTIONS: 'FEATURE_TRANSACTIONS',
  /** Enable the /v1/limits/** spending-limit endpoints */
  LIMITS: 'FEATURE_LIMITS',
  /** Enable the /v1/key-management/** key-management endpoints */
  KEY_MANAGEMENT: 'FEATURE_KEY_MANAGEMENT',
  /** Enable mainnet payment processing (extra guard on top of FEATURE_PAYMENTS) */
  MAINNET_PAYMENTS: 'FEATURE_MAINNET_PAYMENTS',
} as const;

export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

@Injectable()
export class FeatureFlagService implements OnModuleInit {
  private readonly logger = new Logger(FeatureFlagService.name);
  private readonly isProduction: boolean;

  constructor(private readonly config: ConfigService) {
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
  }

  onModuleInit(): void {
    // Log the feature flag state once at startup so operators can confirm
    // which APIs are active without exposing secrets.
    const states = Object.entries(FEATURE_FLAGS)
      .map(([key, envVar]) => `${envVar}=${this.isEnabled(key as FeatureFlagKey)}`)
      .join(', ');

    this.logger.log(`Feature flags initialised [env=${this.isProduction ? 'production' : 'development'}]: ${states}`);

    // In production warn loudly about any explicitly-disabled core flag so
    // operators know something is intentionally off.
    if (this.isProduction) {
      for (const [key, envVar] of Object.entries(FEATURE_FLAGS)) {
        if (!this.isEnabled(key as FeatureFlagKey)) {
          this.logger.warn(
            `[PRODUCTION] Feature flag ${envVar} is DISABLED. The corresponding API surface will be unavailable.`,
          );
        }
      }
    }
  }

  /**
   * Returns true when the feature flag is enabled.
   *
   * Resolution order:
   *  - MAINNET_PAYMENTS is deny-by-default: it is false unless explicitly set
   *    to a truthy token ('true', '1', 'yes', 'on'). Unset, blank, or any other
   *    value resolves to false (fail-closed mainnet default).
   *  - Core API flags default to true when unset to ensure fresh deploys serve
   *    core APIs, and must be explicitly set to "false" to disable.
   */
  isEnabled(flag: FeatureFlagKey): boolean {
    const envVar = FEATURE_FLAGS[flag];
    const raw = this.config.get<string>(envVar);

    // Mainnet payment flag is deny-by-default (issue #965)
    if (flag === 'MAINNET_PAYMENTS') {
      if (raw === undefined || raw === null || raw.trim() === '') {
        return false;
      }
      const normalized = raw.trim().toLowerCase();
      return ['1', 'true', 'yes', 'on'].includes(normalized);
    }

    // Only treat core API flags as disabled when explicitly set to the string "false"
    if (raw !== undefined && raw !== null && raw.trim().toLowerCase() === 'false') {
      return false;
    }

    return true;
  }

  /**
   * Convenience inverse of isEnabled.
   */
  isDisabled(flag: FeatureFlagKey): boolean {
    return !this.isEnabled(flag);
  }

  /**
   * Returns a snapshot of all flags and their current values.
   * Safe to expose in health/debug endpoints — contains no secrets.
   */
  getAll(): Record<string, boolean> {
    return Object.fromEntries(
      Object.entries(FEATURE_FLAGS).map(([key]) => [
        FEATURE_FLAGS[key as FeatureFlagKey],
        this.isEnabled(key as FeatureFlagKey),
      ]),
    );
  }
}
