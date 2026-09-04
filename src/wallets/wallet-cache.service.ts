import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';
import { Wallet } from './domain/wallet.model';

/**
 * Wallet Cache Service
 *
 * Manages caching for wallet lookups and data to reduce database queries.
 * Provides cache management operations including get, set, and invalidation.
 *
 * Cache Keys:
 * - wallet:<walletId> - Cached wallet by ID
 * - wallet:user:<userId>:<network> - Cached wallet by user and network
 */
@Injectable()
export class WalletCacheService {
  private readonly logger = new Logger(WalletCacheService.name);

  // Cache TTL (5 minutes in milliseconds)
  private readonly WALLET_CACHE_TTL = 5 * 60 * 1000;

  // Cache key prefixes
  private readonly WALLET_ID_PREFIX = 'wallet:';
  private readonly WALLET_USER_PREFIX = 'wallet:user:';

  constructor(private readonly cache: CacheService) {}

  /**
   * Get cached wallet by ID
   * @param walletId - The wallet ID to retrieve
   * @returns Cached wallet or null if not found or expired
   */
  getWalletById(walletId: string): Wallet | null {
    const cacheKey = this.buildWalletIdKey(walletId);
    return this.cache.get<Wallet>(cacheKey);
  }

  /**
   * Set wallet in cache by ID
   * @param walletId - The wallet ID
   * @param wallet - The wallet data to cache
   */
  setWalletById(walletId: string, wallet: Wallet): void {
    const cacheKey = this.buildWalletIdKey(walletId);
    this.cache.set(cacheKey, wallet, this.WALLET_CACHE_TTL);
    this.logger.debug(`Cached wallet ${walletId} with TTL ${this.WALLET_CACHE_TTL}ms`);
  }

  /**
   * Get cached wallet by user and network
   * @param userId - The user ID
   * @param network - The network (e.g., TESTNET, MAINNET)
   * @returns Cached wallet or null if not found or expired
   */
  getWalletByUser(userId: string, network: string): Wallet | null {
    const cacheKey = this.buildWalletUserKey(userId, network);
    return this.cache.get<Wallet>(cacheKey);
  }

  /**
   * Set wallet in cache by user and network
   * @param userId - The user ID
   * @param network - The network
   * @param wallet - The wallet data to cache
   */
  setWalletByUser(userId: string, network: string, wallet: Wallet): void {
    const cacheKey = this.buildWalletUserKey(userId, network);
    this.cache.set(cacheKey, wallet, this.WALLET_CACHE_TTL);
    this.logger.debug(
      `Cached wallet for user ${userId} on ${network} with TTL ${this.WALLET_CACHE_TTL}ms`,
    );
  }

  /**
   * Invalidate cached wallet by ID
   * Clears cache entry when wallet is updated or deleted
   * @param walletId - The wallet ID to invalidate
   */
  invalidateWalletById(walletId: string): void {
    const cacheKey = this.buildWalletIdKey(walletId);
    const deleted = this.cache.delete(cacheKey);
    if (deleted) {
      this.logger.debug(`Invalidated cache for wallet ${walletId}`);
    }
  }

  /**
   * Invalidate cached wallet by user and network
   * Clears cache entry when wallet is updated or deleted
   * @param userId - The user ID
   * @param network - The network
   */
  invalidateWalletByUser(userId: string, network: string): void {
    const cacheKey = this.buildWalletUserKey(userId, network);
    const deleted = this.cache.delete(cacheKey);
    if (deleted) {
      this.logger.debug(
        `Invalidated cache for wallet user ${userId} on ${network}`,
      );
    }
  }

  /**
   * Invalidate all cached entries for a user across all networks
   * Useful when user is deleted or suspended
   * @param userId - The user ID
   * @param networks - List of networks to invalidate (e.g., ['TESTNET', 'MAINNET'])
   */
  invalidateUserWallets(userId: string, networks: string[]): void {
    networks.forEach((network) => {
      this.invalidateWalletByUser(userId, network);
    });
    this.logger.debug(
      `Invalidated all wallet caches for user ${userId} across ${networks.length} networks`,
    );
  }

  /**
   * Clear all wallet-related cache entries
   * Use with caution - typically only needed during cache maintenance
   */
  clearAllWalletCache(): void {
    this.cache.clear();
    this.logger.warn('Cleared all wallet cache entries');
  }

  /**
   * Build cache key for wallet lookup by ID
   * @private
   */
  private buildWalletIdKey(walletId: string): string {
    return `${this.WALLET_ID_PREFIX}${walletId}`;
  }

  /**
   * Build cache key for wallet lookup by user and network
   * @private
   */
  private buildWalletUserKey(userId: string, network: string): string {
    return `${this.WALLET_USER_PREFIX}${userId}:${network}`;
  }
}
