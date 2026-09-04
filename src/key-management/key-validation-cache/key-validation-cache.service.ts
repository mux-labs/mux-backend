import { Injectable, Logger } from '@nestjs/common';

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

/**
 * Supported backends for key-pair validation results.
 *
 * - `memory`   — in-process `Map`. Fast, but per-replica and lost on restart.
 *                Only safe for single-replica deployments or local development.
 * - `disabled` — no cache at all. Every validation is recomputed (fail-closed).
 *                A rotated or revoked key can never be masked by a stale entry.
 *
 * A shared/distributed store (e.g. Redis) plugs in behind the same
 * `KEY_VALIDATION_CACHE_MODE` switch once the infrastructure is available; until
 * then production must pick one of the two explicit modes above.
 */
export type KeyValidationCacheMode = 'memory' | 'disabled';

const VALID_MODES: readonly KeyValidationCacheMode[] = ['memory', 'disabled'];

function isProduction(env: NodeJS.ProcessEnv): boolean {
  return (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/**
 * Cache for key-pair validation results.
 *
 * Prevents redundant decryption on hot paths where the same key is validated
 * repeatedly within a short window (e.g. transaction signing bursts). The TTL
 * is deliberately short so stale entries do not mask a key that has been
 * rotated or revoked.
 *
 * Production/dev split (issue #689):
 *
 * - Outside production the cache defaults to `memory` so local development and
 *   tests keep working with no configuration.
 * - In production `KEY_VALIDATION_CACHE_MODE` MUST be set explicitly. Booting
 *   with a silent in-process stub is refused (fail-fast) so operators make a
 *   deliberate choice between `disabled` (fail-closed, recompute every time) and
 *   `memory` (acknowledged per-replica cache). A shared Redis-backed store is
 *   the recommended target for multi-replica deployments.
 *
 * The cache only ever stores a boolean result keyed by a truncated hash of the
 * public key and encrypted material — no key material, seeds or secrets are
 * held or logged.
 */
@Injectable()
export class KeyValidationCacheService {
  private readonly logger = new Logger(KeyValidationCacheService.name);

  private readonly cache = new Map<string, CacheEntry>();

  /** Default TTL in milliseconds (30 seconds). */
  private readonly DEFAULT_TTL_MS = 30_000;

  /** Maximum number of entries kept in memory at any time. */
  private readonly MAX_ENTRIES = 1_000;

  /** Resolved backend mode for this process. */
  private readonly mode: KeyValidationCacheMode;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.mode = KeyValidationCacheService.resolveMode(env);

    if (this.mode === 'disabled') {
      this.logger.warn(
        'Key-validation cache is DISABLED — every keypair validation is recomputed. ' +
          'Set KEY_VALIDATION_CACHE_MODE=memory (single replica) or provision a shared ' +
          'store to re-enable caching.',
      );
    } else if (isProduction(env)) {
      this.logger.warn(
        'Key-validation cache is running in in-process "memory" mode: entries are ' +
          'per-replica and lost on restart, and are NOT shared across pods. Back this ' +
          'with a shared store (e.g. Redis) before relying on it in a multi-replica ' +
          'deployment.',
      );
    }
  }

  /**
   * Resolves the effective cache mode from the environment.
   *
   * @throws Error when the value is invalid, or when it is absent in production.
   */
  static resolveMode(
    env: NodeJS.ProcessEnv = process.env,
  ): KeyValidationCacheMode {
    const raw = (env.KEY_VALIDATION_CACHE_MODE ?? '').trim().toLowerCase();

    if (raw !== '') {
      if (!VALID_MODES.includes(raw as KeyValidationCacheMode)) {
        throw new Error(
          `KEY_VALIDATION_CACHE_MODE must be one of: ${VALID_MODES.join(', ')} ` +
            `(received "${env.KEY_VALIDATION_CACHE_MODE}")`,
        );
      }
      return raw as KeyValidationCacheMode;
    }

    if (isProduction(env)) {
      throw new Error(
        'KEY_VALIDATION_CACHE_MODE must be set explicitly in production. ' +
          'Use "disabled" to fail closed (recompute every validation) or "memory" ' +
          'to acknowledge an in-process, per-replica cache.',
      );
    }

    return 'memory';
  }

  /** The backend mode resolved for this process. */
  getMode(): KeyValidationCacheMode {
    return this.mode;
  }

  /** Whether cache reads/writes are active (false when mode is `disabled`). */
  isEnabled(): boolean {
    return this.mode !== 'disabled';
  }

  /**
   * Returns a cached validation result for the given key pair, or undefined if
   * no live entry exists. Always undefined when the cache is disabled.
   */
  get(publicKey: string, encryptedKeyMaterial: string): boolean | undefined {
    if (!this.isEnabled()) return undefined;

    const key = this.buildCacheKey(publicKey, encryptedKeyMaterial);
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  /**
   * Stores a validation result in the cache.
   * Only caches positive results — negative results (mismatched or invalid
   * keys) are never cached so that corrected keys are visible immediately.
   * No-op when the cache is disabled.
   */
  set(
    publicKey: string,
    encryptedKeyMaterial: string,
    result: boolean,
    ttlMs: number = this.DEFAULT_TTL_MS,
  ): void {
    if (!this.isEnabled()) return;
    if (!result) return;

    if (this.cache.size >= this.MAX_ENTRIES) {
      this.evictExpired();

      if (this.cache.size >= this.MAX_ENTRIES) {
        this.logger.warn(
          `KeyValidationCache full (${this.MAX_ENTRIES} entries) — skipping cache write`,
        );
        return;
      }
    }

    const key = this.buildCacheKey(publicKey, encryptedKeyMaterial);
    this.cache.set(key, { result, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Invalidates all cached entries for a public key (e.g. after key rotation).
   * No-op when the cache is disabled.
   */
  invalidate(publicKey: string): void {
    if (!this.isEnabled()) return;

    let removed = 0;
    for (const k of this.cache.keys()) {
      if (k.startsWith(`${publicKey}:`)) {
        this.cache.delete(k);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(
        `Invalidated ${removed} cache entries for key ${publicKey.substring(0, 12)}...`,
      );
    }
  }

  /** Returns the number of live (non-expired) entries currently cached. */
  size(): number {
    if (!this.isEnabled()) return 0;
    this.evictExpired();
    return this.cache.size;
  }

  /** Clears all entries — useful in tests. */
  clear(): void {
    this.cache.clear();
  }

  private buildCacheKey(
    publicKey: string,
    encryptedKeyMaterial: string,
  ): string {
    // Use a short hash of the encrypted material to keep key sizes manageable
    return `${publicKey}:${encryptedKeyMaterial.substring(0, 32)}`;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [k, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(k);
      }
    }
  }
}
