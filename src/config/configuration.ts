import { registerAs } from '@nestjs/config';

/**
 * Stable error codes for mainnet payment feature-flag denials.
 * Fail-closed: any surface gated by the mainnet payment flag must reject
 * with one of these codes when the flag is not explicitly enabled.
 */
export const MAINNET_PAYMENT_FLAG_ERROR_CODES = {
  DISABLED: 'MAINNET_PAYMENT_FLAG_DISABLED',
  MISCONFIGURED: 'MAINNET_PAYMENT_FLAG_MISCONFIGURED',
  UNAUTHORIZED: 'MAINNET_PAYMENT_FLAG_UNAUTHORIZED',
} as const;

export type MainnetPaymentFlagErrorCode =
  (typeof MAINNET_PAYMENT_FLAG_ERROR_CODES)[keyof typeof MAINNET_PAYMENT_FLAG_ERROR_CODES];

/**
 * Typed, env-driven mainnet payment feature flag.
 *
 * Invariants:
 * - Default OFF (fail-closed): mainnet payments are denied unless explicitly enabled.
 * - Testnet behavior is unchanged and never gated by this flag.
 * - Only owner/admin roles may toggle the flag at runtime.
 */
export interface MainnetPaymentFlag {
  /** Whether mainnet payments are enabled. Defaults to false. */
  enabled: boolean;
  /** Network this flag applies to. */
  network: 'mainnet' | 'testnet';
  /** Stable error code to surface when a mainnet payment is denied. */
  denialCode: MainnetPaymentFlagErrorCode;
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

/**
 * Resolve the mainnet payment feature flag from the environment.
 *
 * Fail-closed: an unrecognized or missing value resolves to disabled.
 * The flag is only ever enabled when the network is explicitly mainnet AND
 * the enable switch is truthy; testnet is never gated.
 */
export const resolveMainnetPaymentFlag = (
  env: NodeJS.ProcessEnv = process.env,
): MainnetPaymentFlag => {
  const network = (env.STELLAR_NETWORK ?? env.SOROBAN_NETWORK ?? 'testnet')
    .trim()
    .toLowerCase();

  if (network !== 'mainnet') {
    return {
      enabled: false,
      network: 'testnet',
      denialCode: MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED,
    };
  }

  const enabled = parseBoolean(env.MAINNET_PAYMENT_ENABLED, false);

  return {
    enabled,
    network: 'mainnet',
    denialCode: enabled
      ? MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED
      : MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED,
  };
};

/**
 * Ops-safe, secret-free snapshot of the flag for logs/metrics.
 * Never includes keys, JWTs, or webhook secrets.
 */
export const mainnetPaymentFlagSnapshot = (
  flag: MainnetPaymentFlag,
): Record<string, string | boolean> => ({
  mainnetPaymentEnabled: flag.enabled,
  network: flag.network,
  denialCode: flag.denialCode,
});

export default registerAs('configuration', () => ({
  mainnetPayment: resolveMainnetPaymentFlag(),
}));
