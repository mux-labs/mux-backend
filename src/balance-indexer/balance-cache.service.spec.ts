import { BalanceCacheService } from './balance-cache.service';
import { CacheService } from '../common/cache/cache.service';
import { AssetType, BalanceSyncStatus, WalletBalance } from './domain/balance.model';

const WALLET_ID = 'wallet-cache-test';
const nativeAsset = { type: AssetType.NATIVE };

function makeBalance(overrides: Partial<WalletBalance> = {}): WalletBalance {
  return {
    id: 'bal-1',
    walletId: WALLET_ID,
    assetType: AssetType.NATIVE,
    assetCode: null,
    assetIssuer: null,
    balance: '100.0000000',
    syncStatus: BalanceSyncStatus.SYNCED,
    lastSyncedAt: new Date(),
    lastSyncedLedger: 1000,
    lastReconciledAt: null,
    reconciliationAttempts: 0,
    onChainBalance: '100.0000000',
    mismatchDetectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('BalanceCacheService', () => {
  let service: BalanceCacheService;
  let cacheService: CacheService;

  beforeEach(() => {
    cacheService = new CacheService();
    service = new BalanceCacheService(cacheService);
  });

  afterEach(() => {
    cacheService.clear();
  });

  it('returns null for a balance not yet cached', () => {
    const result = service.get(WALLET_ID, nativeAsset);
    expect(result).toBeNull();
  });

  it('stores and retrieves a balance by wallet + asset', () => {
    const balance = makeBalance();
    service.set(WALLET_ID, nativeAsset, balance);
    expect(service.get(WALLET_ID, nativeAsset)).toEqual(balance);
  });

  it('returns null after invalidating a specific asset', () => {
    const balance = makeBalance();
    service.set(WALLET_ID, nativeAsset, balance);
    service.invalidate(WALLET_ID, nativeAsset);
    expect(service.get(WALLET_ID, nativeAsset)).toBeNull();
  });

  it('clears all entries on invalidateAll', () => {
    const usdcAsset = { type: AssetType.CREDIT_ALPHANUM4, code: 'USDC', issuer: 'GISSUER' };
    service.set(WALLET_ID, nativeAsset, makeBalance());
    service.set(WALLET_ID, usdcAsset, makeBalance({ assetType: AssetType.CREDIT_ALPHANUM4, assetCode: 'USDC', assetIssuer: 'GISSUER' }));
    service.invalidateAll(WALLET_ID);
    expect(service.get(WALLET_ID, nativeAsset)).toBeNull();
    expect(service.get(WALLET_ID, usdcAsset)).toBeNull();
  });

  it('isolates cache entries for different wallets', () => {
    const otherWallet = 'wallet-other';
    const balance = makeBalance();
    service.set(WALLET_ID, nativeAsset, balance);
    expect(service.get(otherWallet, nativeAsset)).toBeNull();
  });

  it('isolates cache entries for different assets on the same wallet', () => {
    const usdcAsset = { type: AssetType.CREDIT_ALPHANUM4, code: 'USDC', issuer: 'GISSUER' };
    const nativeBalance = makeBalance();
    const usdcBalance = makeBalance({ assetType: AssetType.CREDIT_ALPHANUM4, assetCode: 'USDC', balance: '50.0' });
    service.set(WALLET_ID, nativeAsset, nativeBalance);
    service.set(WALLET_ID, usdcAsset, usdcBalance);
    expect(service.get(WALLET_ID, nativeAsset)).toEqual(nativeBalance);
    expect(service.get(WALLET_ID, usdcAsset)).toEqual(usdcBalance);
  });
});
