import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';

/**
 * Short-lived cache for Stellar Horizon account-existence lookups.
 * 30-second TTL eliminates duplicate round-trips without hiding account creation.
 * Keys use public keys only — no private keys or PII ever cached.
 */
@Injectable()
export class HorizonAccountCacheService {
  private readonly logger = new Logger(HorizonAccountCacheService.name);
  static readonly TTL_MS = 30_000;
  private static readonly PREFIX = 'horizon:account:exists:';

  constructor(private readonly cache: CacheService) {}

  get(publicKey: string): boolean | null {
    const hit = this.cache.get<boolean>(this.key(publicKey));
    if (hit !== null) this.logger.debug(`[horizon-cache] hit key=${publicKey.substring(0, 8)}…`);
    return hit;
  }

  set(publicKey: string, exists: boolean, ttlMs = HorizonAccountCacheService.TTL_MS): void {
    this.cache.set(this.key(publicKey), exists, ttlMs);
    this.logger.debug(`[horizon-cache] set key=${publicKey.substring(0, 8)}… exists=${exists} ttl=${ttlMs}ms`);
  }

  /** Evict entry after an account is funded so the next lookup hits Horizon. */
  invalidate(publicKey: string): void {
    if (this.cache.delete(this.key(publicKey)))
      this.logger.debug(`[horizon-cache] invalidated key=${publicKey.substring(0, 8)}…`);
  }

  private key(pk: string): string { return `${HorizonAccountCacheService.PREFIX}${pk}`; }
}
