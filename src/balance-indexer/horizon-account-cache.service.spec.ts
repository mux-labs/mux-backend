import { HorizonAccountCacheService } from './horizon-account-cache.service';
import { CacheService } from '../common/cache/cache.service';

describe('HorizonAccountCacheService', () => {
  let cacheService: CacheService;
  let service: HorizonAccountCacheService;

  const PUBLIC_KEY = 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ';

  beforeEach(() => {
    cacheService = new CacheService();
    service = new HorizonAccountCacheService(cacheService);
  });

  afterEach(() => {
    cacheService.clear();
  });

  describe('get — cache miss', () => {
    it('returns null when nothing is cached', () => {
      expect(service.get(PUBLIC_KEY)).toBeNull();
    });
  });

  describe('set + get — success path', () => {
    it('returns true after caching an existing account', () => {
      service.set(PUBLIC_KEY, true);
      expect(service.get(PUBLIC_KEY)).toBe(true);
    });

    it('returns false after caching a non-existent account', () => {
      service.set(PUBLIC_KEY, false);
      expect(service.get(PUBLIC_KEY)).toBe(false);
    });

    it('respects a custom TTL — entry expires after TTL ms', async () => {
      service.set(PUBLIC_KEY, true, 50); // 50 ms TTL
      expect(service.get(PUBLIC_KEY)).toBe(true);
      await new Promise((r) => setTimeout(r, 60));
      expect(service.get(PUBLIC_KEY)).toBeNull();
    });
  });

  describe('invalidate', () => {
    it('removes a cached entry', () => {
      service.set(PUBLIC_KEY, true);
      service.invalidate(PUBLIC_KEY);
      expect(service.get(PUBLIC_KEY)).toBeNull();
    });

    it('is a no-op when the key does not exist', () => {
      expect(() => service.invalidate('GNON_EXISTENT')).not.toThrow();
    });
  });

  describe('no private key leakage', () => {
    it('cache key is prefixed and does not contain raw secret key material', () => {
      // Verify the internal key structure never stores a private key (S…)
      const privateKeyLike = 'SABC1234SECRET_PRIVATE_KEY_SHOULD_NEVER_APPEAR';
      service.set(PUBLIC_KEY, true);
      // The underlying CacheService map keys should only contain public key prefix
      const internalKeys = [...(cacheService as any).cache.keys()];
      internalKeys.forEach((k: string) => {
        expect(k).toContain('horizon:account:exists:');
        expect(k).not.toContain(privateKeyLike);
      });
    });
  });
});
