import { ErrorCode } from '../common/dto/error-envelope.dto';
import { PaymentNetwork } from './payment-money-path.model';

/**
 * Payment money-path policy.
 *
 * This is the **server-side source of truth** for the feature flags that gate
 * value movement and for the role rules that decide who may trigger it. The
 * contract is documented in `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` (flag table)
 * and `docs/PAYMENT-DRY-RUN.md` (dry-run invariants); this module is the only
 * place that interprets the environment, so a client can never enable a flag by
 * sending a header, query param, or body field.
 *
 * Invariants:
 *  1. **Deny-by-default.** A flag is on only when its env var holds an explicit
 *     truthy value. Unset, blank, misspelled, or unparseable values are `false`.
 *  2. **Kill-switch first.** `PAYMENT_KILL_SWITCH=true` stops every payment
 *     write — live and dry-run — with `PAYMENT_KILL_SWITCH_ENGAGED`.
 *  3. **Mainnet is opt-in.** Live mainnet value movement is refused with
 *     `PAYMENT_MAINNET_DISABLED` unless `PAYMENT_MAINNET_ENABLED` is truthy.
 *     Testnet is never gated by the mainnet flag.
 *  4. **Fail-closed on misconfiguration.** A production deployment that enables
 *     mainnet payments without a mainnet Horizon endpoint refuses live mainnet
 *     writes with `PAYMENT_MAINNET_MISCONFIGURED` rather than submitting value
 *     against an unknown network.
 *  5. **No silent downgrade.** Legacy env names are honoured as aliases so an
 *     existing deployment cannot be flipped by a rename, and the resolved
 *     source of each decision is reported (secret-free) for operators.
 */

/** Canonical env var for live mainnet payment submission (docs table). */
export const PAYMENT_MAINNET_ENABLED_ENV = 'PAYMENT_MAINNET_ENABLED';

/** Canonical env var for the dry-run entrypoint (docs table). */
export const PAYMENT_DRY_RUN_ENABLED_ENV = 'PAYMENT_DRY_RUN_ENABLED';

/** Canonical env var for the payment kill-switch (docs table). */
export const PAYMENT_KILL_SWITCH_ENV = 'PAYMENT_KILL_SWITCH';

/**
 * Legacy aliases for the mainnet payment switch, in precedence order.
 *
 * `MAINNET_PAYMENT_ENABLED` is what `src/config/configuration.ts` reads and
 * `MAINNET_PAYMENTS_ENABLED` is what `.env.example` shipped; both are accepted
 * so the documented rename does not silently disable (or re-enable) a live
 * money path during a rollout.
 */
export const LEGACY_MAINNET_ENABLED_ENVS: readonly string[] = [
  'MAINNET_PAYMENT_ENABLED',
  'MAINNET_PAYMENTS_ENABLED',
  'FEATURE_MAINNET_PAYMENTS',
];

/** Env var holding the mainnet Horizon endpoint. */
export const MAINNET_HORIZON_URL_ENV = 'STELLAR_HORIZON_MAINNET_URL';

/** Env vars naming the network this deployment targets. */
export const PAYMENT_NETWORK_ENVS: readonly string[] = [
  'STELLAR_NETWORK',
  'SOROBAN_NETWORK',
];

/** Roles that may trigger a payment. Everyone else is denied. */
export const PAYMENT_MONEY_PATH_ROLES: readonly string[] = [
  'owner',
  'delegate',
  'guardian',
  'api-key',
  'jwt',
];

/** Why a live (value-moving) submission was refused, if it was. */
export interface LiveSubmissionDecision {
  /** True when the write may proceed to submission. */
  allowed: boolean;
  /** Stable error code explaining a refusal. */
  code?: ErrorCode;
}

/**
 * Parse a boolean env value, fail-closed.
 *
 * Matches `resolveMainnetPaymentFlag` in `src/config/configuration.ts` so the
 * boot-time flag service and the money path agree on what "on" means. Anything
 * that is not an explicit truthy token resolves to `false`.
 */
export function parseFlagBoolean(value: string | undefined): boolean {
  if (value === undefined || value === null || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

/**
 * Resolve the mainnet payment flag from the canonical var or a legacy alias.
 *
 * Returns the first var that is actually set so the snapshot can tell
 * operators which variable is in effect. An explicit falsy value wins: an
 * operator who wrote `false` gets `false`, even if a stale alias elsewhere
 * still says `true`.
 */
export function resolveMainnetEnabledSource(env: NodeJS.ProcessEnv): {
  enabled: boolean;
  source: string;
} {
  const candidates = [
    PAYMENT_MAINNET_ENABLED_ENV,
    ...LEGACY_MAINNET_ENABLED_ENVS,
  ];
  for (const name of candidates) {
    const raw = env[name];
    if (raw !== undefined && raw !== null && raw.trim() !== '') {
      return { enabled: parseFlagBoolean(raw), source: name };
    }
  }
  return { enabled: false, source: 'unset' };
}

/** Resolve the configured network, defaulting to testnet (fail-safe). */
export function resolvePaymentNetwork(env: NodeJS.ProcessEnv): PaymentNetwork {
  for (const name of PAYMENT_NETWORK_ENVS) {
    const raw = env[name];
    if (raw !== undefined && raw !== null && raw.trim() !== '') {
      return raw.trim().toLowerCase() === 'mainnet'
        ? PaymentNetwork.MAINNET
        : PaymentNetwork.TESTNET;
    }
  }
  return PaymentNetwork.TESTNET;
}

/**
 * Resolve every money-path flag from the environment. Pure: the same env always
 * produces the same decision, which is what makes the policy unit testable.
 */
export function resolvePaymentMoneyPathFlags(
  env: NodeJS.ProcessEnv = process.env,
): PaymentMoneyPathFlags {
  const killSwitchRaw = env[PAYMENT_KILL_SWITCH_ENV];
  const dryRunRaw = env[PAYMENT_DRY_RUN_ENABLED_ENV];
  const { enabled: mainnetEnabled, source } = resolveMainnetEnabledSource(env);
  const network = resolvePaymentNetwork(env);

  const mainnetHorizonConfigured =
    (env[MAINNET_HORIZON_URL_ENV] ?? '').trim().length > 0;
  const isProduction =
    (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

  return {
    killSwitchEngaged: parseFlagBoolean(killSwitchRaw),
    dryRunEnabled: parseFlagBoolean(dryRunRaw),
    mainnetEnabled,
    // Enabling mainnet value movement without a mainnet endpoint is a
    // misconfiguration: refuse the write instead of guessing an endpoint.
    mainnetMisconfigured:
      isProduction && mainnetEnabled && !mainnetHorizonConfigured,
    network,
    sources: {
      killSwitch:
        killSwitchRaw === undefined || killSwitchRaw.trim() === ''
          ? 'unset'
          : PAYMENT_KILL_SWITCH_ENV,
      dryRun:
        dryRunRaw === undefined || dryRunRaw.trim() === ''
          ? 'unset'
          : PAYMENT_DRY_RUN_ENABLED_ENV,
      mainnet: source,
    },
  };
}

/** True for the network that moves real value on the public chain. */
export function isMainnet(network: PaymentNetwork): boolean {
  return network === PaymentNetwork.MAINNET;
}

/**
 * Decide whether a live (value-moving) payment may be submitted.
 *
 * Callers MUST refuse the write when `allowed` is false: the invariant is
 * "flag off blocks value", so nothing is signed, persisted, or sent to Horizon.
 */
export function decideLiveSubmission(
  network: PaymentNetwork,
  flags: PaymentMoneyPathFlags,
): LiveSubmissionDecision {
  if (!isMainnet(network)) {
    return { allowed: true };
  }
  if (flags.mainnetMisconfigured) {
    return { allowed: false, code: ErrorCode.PAYMENT_MAINNET_MISCONFIGURED };
  }
  if (!flags.mainnetEnabled) {
    return { allowed: false, code: ErrorCode.PAYMENT_MAINNET_DISABLED };
  }
  return { allowed: true };
}

/**
 * Ops-safe snapshot of the flags for logs and metrics.
 *
 * Booleans, enum strings, and env var *names* only — never a value that could
 * be a secret, and never key material.
 */
export function paymentMoneyPathFlagSnapshot(
  flags: PaymentMoneyPathFlags,
): Record<string, string | boolean> {
  return {
    killSwitchEngaged: flags.killSwitchEngaged,
    dryRunEnabled: flags.dryRunEnabled,
    mainnetEnabled: flags.mainnetEnabled,
    mainnetMisconfigured: flags.mainnetMisconfigured,
    network: flags.network,
    killSwitchSource: flags.sources.killSwitch,
    dryRunSource: flags.sources.dryRun,
    mainnetSource: flags.sources.mainnet,
  };
}

/** Resolved, secret-free view of the money-path flags. */
export interface PaymentMoneyPathFlags {
  /** Every write (live and dry-run) is refused while engaged. */
  killSwitchEngaged: boolean;
  /** The dry-run entrypoint is enabled. */
  dryRunEnabled: boolean;
  /** Live mainnet submission is enabled. */
  mainnetEnabled: boolean;
  /** Mainnet submission is enabled but the mainnet Horizon URL is missing. */
  mainnetMisconfigured: boolean;
  /** Network this deployment targets. */
  network: PaymentNetwork;
  /** Which env var decided each flag (for operators; never a secret). */
  sources: {
    killSwitch: string;
    dryRun: string;
    mainnet: string;
  };
}
