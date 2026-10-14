/**
 * Safety gate for `pnpm prisma:seed` (#928).
 *
 * The demo seed is a **local development tool**. It creates users, wallets
 * (including testnet/mainnet rows) and fake transactions using deterministic
 * placeholder keys. Running it against a shared, staging, or production
 * database would:
 *
 * - overwrite `lastLoginAt` on real users,
 * - create `ACTIVE` wallets whose `encryptedSecret` is a literal placeholder
 *   string that the encryption service can never decrypt (a wallet that looks
 *   usable but is permanently broken), and
 * - pollute payment/transaction history with fabricated money movement.
 *
 * Invariants enforced here (fail-closed, deny-by-default):
 *
 * 1. `NODE_ENV=production` **always** blocks the seed. There is no override.
 * 2. A mainnet network (`STELLAR_NETWORK=PUBLIC`/`MAINNET`) **always** blocks
 *    the seed. There is no override.
 * 3. A non-local `DATABASE_URL` host blocks the seed unless the operator sets
 *    the explicit, documented opt-in `PRISMA_SEED_ALLOW_NON_LOCAL=true`. The
 *    opt-in is intentionally noisy in `.env.example` and in the log output.
 * 4. A missing or unparseable `DATABASE_URL` blocks the seed (never assume
 *    local).
 * 5. Mainnet demo wallets are only created when
 *    `PRISMA_SEED_INCLUDE_MAINNET=true`. Default is off, so a testnet
 *    developer never ends up with a `MAINNET` row pointing at a placeholder
 *    secret.
 *
 * No secret material is ever interpolated into the thrown error: only the
 * offending host and the stable error code are reported.
 */

/** Stable, machine-readable reasons the seed refused to run. */
export const SEED_BLOCK_CODES = {
  /** `NODE_ENV=production` — never seeded, no override. */
  PRODUCTION: 'SEED_BLOCKED_PRODUCTION',
  /** Target network is mainnet/public — never seeded, no override. */
  MAINNET: 'SEED_BLOCKED_MAINNET',
  /** `DATABASE_URL` is missing or unparseable — fail closed. */
  DATABASE_URL: 'SEED_BLOCKED_DATABASE_URL',
  /** `DATABASE_URL` points at a non-local host without the opt-in flag. */
  NON_LOCAL_DATABASE: 'SEED_BLOCKED_NON_LOCAL_DATABASE',
  /** A configured value was present but not a recognized boolean. */
  INVALID_FLAG: 'SEED_BLOCKED_INVALID_FLAG',
} as const;

export type SeedBlockCode =
  (typeof SEED_BLOCK_CODES)[keyof typeof SEED_BLOCK_CODES];

/** Opt-in required to seed a non-local (shared/staging) database. */
export const SEED_ALLOW_NON_LOCAL_ENV = 'PRISMA_SEED_ALLOW_NON_LOCAL';

/** Opt-in required to create the demo `MAINNET` wallet rows. */
export const SEED_INCLUDE_MAINNET_ENV = 'PRISMA_SEED_INCLUDE_MAINNET';

/** Hosts that are unambiguously a developer's own machine / compose stack. */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'host.docker.internal',
  // docker-compose service names used by docs/DOCKER-COMPOSE-LOCAL.md
  'db',
  'postgres',
]);

/** Values treated as a mainnet deployment by `STELLAR_NETWORK`. */
const MAINNET_NETWORKS = new Set(['PUBLIC', 'MAINNET']);

/**
 * Error thrown when the seed refuses to run. Carries a stable `code` so
 * scripts/CI can branch on it without string-matching a human message.
 */
export class SeedNotAllowedError extends Error {
  readonly code: SeedBlockCode;
  /** Host of the rejected `DATABASE_URL` (never credentials). */
  readonly host?: string;

  constructor(code: SeedBlockCode, message: string, host?: string) {
    super(message);
    this.name = 'SeedNotAllowedError';
    this.code = code;
    this.host = host;
  }
}

/**
 * Strict boolean parse. Unlike the permissive `parseBoolean` used for feature
 * flags, an unrecognized value here is an **error** — a typo in
 * `PRISMA_SEED_ALLOW_NON_LOCAL=treu` must not silently disable the gate.
 * Returns `false` for an absent flag (meaning "off") and throws
 * {@link SeedNotAllowedError} with {@link SEED_BLOCK_CODES.INVALID_FLAG} for a
 * value that is present but not a recognized boolean.
 */
function readStrictBoolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = env[key];
  if (raw === undefined || raw === null || raw === '') {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new SeedNotAllowedError(
    SEED_BLOCK_CODES.INVALID_FLAG,
    `${key} must be one of true|false|1|0|yes|no|on|off`,
  );
}

/**
 * Extract the hostname from a `DATABASE_URL` without ever returning the
 * credentials. Returns `undefined` when the URL cannot be parsed.
 */
export function extractDatabaseHost(
  databaseUrl: string | undefined,
): string | undefined {
  if (!databaseUrl) {
    return undefined;
  }
  try {
    const host = new URL(databaseUrl).hostname;
    return host ? host.toLowerCase() : undefined;
  } catch {
    // Prisma accepts connection strings that `URL` rejects (e.g. an unencoded
    // character in the password). Fall back to a conservative manual parse
    // that only ever yields the host segment.
    const withoutScheme = databaseUrl.replace(
      /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//,
      '',
    );
    const authority = withoutScheme.split('/')[0] ?? '';
    const afterCredentials = authority.includes('@')
      ? authority.slice(authority.lastIndexOf('@') + 1)
      : authority;
    const hostAndPort = afterCredentials.split('?')[0] ?? '';
    const host = hostAndPort.startsWith('[')
      ? hostAndPort.slice(0, hostAndPort.indexOf(']') + 1)
      : (hostAndPort.split(':')[0] ?? '');
    return host ? host.toLowerCase() : undefined;
  }
}

/** True when the resolved host belongs to a developer's local machine. */
export function isLocalDatabaseHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  if (LOCAL_HOSTNAMES.has(host)) {
    return true;
  }
  // Any loopback address (127.0.0.0/8, ::1) counts as local.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Pure preflight evaluation. Exported separately from {@link assertSeedAllowed}
 * so it can be unit-tested and reused by CI checks without side effects.
 *
 * Order matters, and it is deliberate:
 *
 * 1. **The non-overridable blocks are evaluated first.** `NODE_ENV=production`
 *    and a mainnet `STELLAR_NETWORK` are reported by their own stable codes
 *    regardless of any flag. A flag typo therefore cannot mask the single most
 *    important refusal an operator needs to see.
 * 2. **Then the flags are parsed strictly.** A malformed `PRISMA_SEED_*` value
 *    is returned as {@link SEED_BLOCK_CODES.INVALID_FLAG} rather than thrown,
 *    so every refusal path — including a typo — is reported through the same
 *    `SeedPreflight.code` channel. The seed's error handler only knows how to
 *    print a code, so a refusal it cannot describe is a refusal an operator
 *    cannot act on.
 */
export function evaluateSeedPreflight(
  env: NodeJS.ProcessEnv = process.env,
): SeedPreflight {
  // (1) Blocks that have no override, checked before anything that can throw.
  const nodeEnv = (env.NODE_ENV ?? '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    return {
      allowed: false,
      code: SEED_BLOCK_CODES.PRODUCTION,
      includeMainnet: false,
    };
  }

  const network = (env.STELLAR_NETWORK ?? '').trim().toUpperCase();
  if (MAINNET_NETWORKS.has(network)) {
    return {
      allowed: false,
      code: SEED_BLOCK_CODES.MAINNET,
      includeMainnet: false,
    };
  }

  // (2) Strict flag parsing, reported as a code instead of an exception.
  let includeMainnet = false;
  let allowNonLocal = false;
  try {
    includeMainnet = readStrictBoolean(env, SEED_INCLUDE_MAINNET_ENV);
    allowNonLocal = readStrictBoolean(env, SEED_ALLOW_NON_LOCAL_ENV);
  } catch {
    return {
      allowed: false,
      code: SEED_BLOCK_CODES.INVALID_FLAG,
      includeMainnet: false,
    };
  }

  const host = extractDatabaseHost(env.DATABASE_URL);
  if (!host) {
    return {
      allowed: false,
      code: SEED_BLOCK_CODES.DATABASE_URL,
      includeMainnet,
    };
  }

  if (!isLocalDatabaseHost(host) && !allowNonLocal) {
    return {
      allowed: false,
      code: SEED_BLOCK_CODES.NON_LOCAL_DATABASE,
      host,
      includeMainnet,
    };
  }

  return { allowed: true, host, includeMainnet };
}

/** Remediation text per stable code. Contains no credentials or secrets. */
const REMEDIATION: Record<SeedBlockCode, (host?: string) => string> = {
  [SEED_BLOCK_CODES.PRODUCTION]: () =>
    'the demo seed must never run with NODE_ENV=production. Run it against a local database.',
  [SEED_BLOCK_CODES.MAINNET]: () =>
    'the demo seed must never target mainnet. Unset STELLAR_NETWORK or set it to TESTNET.',
  [SEED_BLOCK_CODES.DATABASE_URL]: () =>
    'DATABASE_URL is missing or unparseable, so the seed cannot prove it is local.',
  [SEED_BLOCK_CODES.NON_LOCAL_DATABASE]: (host) =>
    `DATABASE_URL points at a non-local host (${host}). Set ${SEED_ALLOW_NON_LOCAL_ENV}=true if this really is a throwaway database.`,
  [SEED_BLOCK_CODES.INVALID_FLAG]: () =>
    'a PRISMA_SEED_* flag was set to a value that is not a recognized boolean.',
};

/**
 * Fail-closed preflight for the seed entrypoint. Throws
 * {@link SeedNotAllowedError} when the environment is not a safe local
 * development environment.
 */
export function assertSeedAllowed(
  env: NodeJS.ProcessEnv = process.env,
): SeedPreflight {
  const preflight = evaluateSeedPreflight(env);
  if (preflight.allowed) {
    return preflight;
  }

  throw new SeedNotAllowedError(
    preflight.code!,
    `Refusing to seed: ${REMEDIATION[preflight.code!](preflight.host)}`,
    preflight.host,
  );
}

/** Result of evaluating the seed preflight. */
export interface SeedPreflight {
  /** True when the seed may proceed. */
  allowed: boolean;
  /** Stable code explaining a refusal; `undefined` when allowed. */
  code?: SeedBlockCode;
  /** Host that was evaluated (never credentials). */
  host?: string;
  /** Whether the demo `MAINNET` wallet rows will be created. */
  includeMainnet: boolean;
}
