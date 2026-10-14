import { Injectable } from '@nestjs/common';
import { CacheService } from '../common/cache/cache.service';
import { WalletBalance, Asset } from './domain/balance.model';

/**
 * Thin cache layer for wallet balances.
 *
 * Wraps CacheService with balance-domain key generation and a fixed TTL.
 * In a Redis-backed deployment the invalidateAll helper would use SCAN+DEL
 * on the wallet prefix; with the in-memory CacheService it falls back to
 * a full clear so correctness is never compromised.
 */
@Injectable()
export class BalanceCacheService {
  private static readonly BALANCE_TTL_MS = 60_000;

  constructor(private readonly cache: CacheService) {}

  get(walletId: string, asset: Asset): WalletBalance | null {
    return this.cache.get<WalletBalance>(this.key(walletId, asset));
  }

  set(walletId: string, asset: Asset, balance: WalletBalance): void {
    this.cache.set(
      this.key(walletId, asset),
      balance,
      BalanceCacheService.BALANCE_TTL_MS,
    );
  }

  invalidate(walletId: string, asset: Asset): void {
    this.cache.delete(this.key(walletId, asset));
  }

  invalidateAll(_walletId: string): void {
    this.cache.clear();
  }

  private key(walletId: string, asset: Asset): string {
    return `balance:${walletId}:${asset.type}:${asset.code ?? ''}:${asset.issuer ?? ''}`;
  }
}
