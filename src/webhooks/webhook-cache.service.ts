import { Injectable } from '@nestjs/common';

export const WEBHOOK_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

// TODO: replace with Redis-backed cache for multi-instance deployments
@Injectable()
export class WebhookCacheService {
  private readonly store = new Map<string, CacheEntry>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number = WEBHOOK_CACHE_TTL_MS): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  endpointKey(endpointId: string): string {
    return `webhook:endpoint:${endpointId}`;
  }
}
