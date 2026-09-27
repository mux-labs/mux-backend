import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Boot-time transaction environment validator.
 *
 * Design notes (issue #914):
 * - The validator is a fail-closed boot gate for money-path configuration. It
 *   runs during NestJS module init (`OnModuleInit`), so a misconfigured
 *   deployment refuses to start instead of silently sending mainnet payment
 *   submissions to an unknown/incorrect Horizon network.
 * - Invariants:
 *   1. Production + mainnet payment feature enabled + missing
 *      `STELLAR_HORIZON_MAINNET_URL` => startup FAILS (deny-by-default).
 *   2. Any value other than an explicit truthy flag is treated as disabled.
 *   3. Non-production environments are never blocked by this validator
 *      (testnet/local flows must not be disrupted by missing mainnet config).
 *   4. The validator never logs secrets, key material, JWTs, or webhook
 *      secrets; the emitted snapshot is booleans + stable enum strings only.
 * - Cross-links: `test/transaction-env-validator.e2e-spec.ts`,
 *   `docs/MAINNET-PAYMENT-FEATURE-FLAG.md`.
 */

export const TRANSACTION_ENV_VALIDATOR_ERROR_CODES = {
  /** Mainnet payments/submission enabled but the mainnet Horizon URL is unset. */
  MAINNET_HORIZON_MISCONFIGURED:
    'TRANSACTION_ENV_VALIDATOR_MAINNET_HORIZON_MISCONFIGURED',
} as const;

export type TransactionEnvValidatorErrorCode =
  (typeof TRANSACTION_ENV_VALIDATOR_ERROR_CODES)[keyof typeof TRANSACTION_ENV_VALIDATOR_ERROR_CODES];

const MAINNET_PAYMENT_FLAG_ENV = 'FEATURE_MAINNET_PAYMENTS';
const MAINNET_PAYMENT_SUBMIT_FLAG_ENV = 'FEATURE_MAINNET_PAYMENT_SUBMIT';
const MAINNET_HORIZON_URL_ENV = 'STELLAR_HORIZON_MAINNET_URL';

const NETWORK_ENV_KEYS = ['STELLAR_NETWORK', 'SOROBAN_NETWORK'] as const;

/**
 * Ops-safe, secret-free snapshot of the transaction environment. Only used
 * for logging/metrics; never contains keys, JWTs, or webhook secrets.
 */
export interface TransactionEnvSnapshot {
  valid: boolean;
  nodeEnv: string;
  network: string;
  featureMainnetPaymentsEnabled: boolean;
  featureMainnetPaymentSubmitEnabled: boolean;
  mainnetHorizonUrlConfigured: boolean;
  errors: TransactionEnvValidatorErrorCode[];
}

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

@Injectable()
export class TransactionEnvValidatorService implements OnModuleInit {
  private readonly logger = new Logger(TransactionEnvValidatorService.name);

  /**
   * Fail-closed boot gate. Throws when a production deployment enables a
   * mainnet payment surface without configuring the mainnet Horizon URL.
   */
  async onModuleInit(): Promise<void> {
    const snapshot = this.validate(process.env);

    if (snapshot.valid) {
      this.logger.log(`Transaction environment validated: ${JSON.stringify(snapshot)}`);
      return;
    }

    const message = this.buildErrorMessage(snapshot);
    this.logger.error(message);
    throw new Error(message);
  }

  /**
   * Pure validation used by the boot gate (and unit tests). Reads only
   * low-cardinality env booleans/names; the returned snapshot is secret-free.
   */
  validate(env: NodeJS.ProcessEnv = process.env): TransactionEnvSnapshot {
    const nodeEnv = (env.NODE_ENV ?? 'development').trim().toLowerCase();
    const isProduction = nodeEnv === 'production';

    const network =
      (env[NETWORK_ENV_KEYS[0]] ?? env[NETWORK_ENV_KEYS[1]] ?? 'testnet')
        .trim()
        .toLowerCase();

    const featureMainnetPaymentsEnabled = parseBoolean(
      env[MAINNET_PAYMENT_FLAG_ENV],
      false,
    );
    const featureMainnetPaymentSubmitEnabled = parseBoolean(
      env[MAINNET_PAYMENT_SUBMIT_FLAG_ENV],
      false,
    );
    const mainnetHorizonUrlConfigured =
      (env[MAINNET_HORIZON_URL_ENV] ?? '').trim().length > 0;

    const errors: TransactionEnvValidatorErrorCode[] = [];

    // Fail closed: production must never enable a mainnet payment surface
    // without a mainnet Horizon endpoint.
    if (
      isProduction &&
      (featureMainnetPaymentsEnabled || featureMainnetPaymentSubmitEnabled) &&
      !mainnetHorizonUrlConfigured
    ) {
      errors.push(
        TRANSACTION_ENV_VALIDATOR_ERROR_CODES.MAINNET_HORIZON_MISCONFIGURED,
      );
    }

    return {
      valid: errors.length === 0,
      nodeEnv,
      network,
      featureMainnetPaymentsEnabled,
      featureMainnetPaymentSubmitEnabled,
      mainnetHorizonUrlConfigured,
      errors,
    };
  }

  private buildErrorMessage(snapshot: TransactionEnvSnapshot): string {
    const parts: string[] = [];
    if (snapshot.featureMainnetPaymentsEnabled) {
      parts.push(
        `${MAINNET_PAYMENT_FLAG_ENV} is enabled but ${MAINNET_HORIZON_URL_ENV} is not configured`,
      );
    }
    if (snapshot.featureMainnetPaymentSubmitEnabled) {
      parts.push(
        `${MAINNET_PAYMENT_SUBMIT_FLAG_ENV} is enabled but ${MAINNET_HORIZON_URL_ENV} is not configured`,
      );
    }

    const joined =
      parts.length > 0
        ? parts.join('; ')
        : 'Mainnet payment config is invalid';
    const code = TRANSACTION_ENV_VALIDATOR_ERROR_CODES.MAINNET_HORIZON_MISCONFIGURED;
    return (
      `${joined}. ` +
      `Refusing to start in NODE_ENV=${snapshot.nodeEnv}: mainnet payment submissions ` +
      `would target an unknown Horizon network (${code}). ` +
      `Set ${MAINNET_HORIZON_URL_ENV} or disable the mainnet payment feature flag before starting.`
    );
  }
}