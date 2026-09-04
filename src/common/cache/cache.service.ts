import { Injectable, Logger } from '@nestjs/common';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  /**
   * Retrieve a value from cache by key
   * Returns null if key doesn't exist or has expired
   */
  get<T = unknown>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    this.logger.debug(`Cache hit for key: ${key}`);
    return entry.value as T;
  }

  /**
   * Store a value in cache with optional TTL (in milliseconds)
   * Default TTL is 5 minutes (300000ms)
   */
  set<T = unknown>(key: string, value: T, ttl: number = 300000): void {
    const expiresAt = Date.now() + ttl;
    this.cache.set(key, { value, expiresAt });
    this.logger.debug(`Cache set for key: ${key} with TTL ${ttl}ms`);
  }

  /**
   * Remove a key from cache
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear();
    this.logger.debug('Cache cleared');
  }

  /**
   * Get cache size
   */
  size(): number {
    return this.cache.size;
  }
}
