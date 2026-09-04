import { KeyValidationCacheService } from './key-validation-cache.service';

describe('KeyValidationCacheService', () => {
  let cache: KeyValidationCacheService;

  beforeEach(() => {
    cache = new KeyValidationCacheService();
  });

  afterEach(() => {
    cache.clear();
    jest.useRealTimers();
  });

  describe('get / set', () => {
    it('returns undefined for a key that was never cached', () => {
      expect(cache.get('GPUB', 'enc')).toBeUndefined();
    });

    it('returns the cached result within the TTL window', () => {
      cache.set('GPUB', 'enc', true, 5000);
      expect(cache.get('GPUB', 'enc')).toBe(true);
    });

    it('does NOT cache negative results', () => {
      cache.set('GPUB', 'enc', false, 5000);
      expect(cache.get('GPUB', 'enc')).toBeUndefined();
    });

    it('returns undefined after the TTL expires', () => {
      jest.useFakeTimers();
      cache.set('GPUB', 'enc', true, 100);
      jest.advanceTimersByTime(101);
      expect(cache.get('GPUB', 'enc')).toBeUndefined();
    });

    it('treats different public keys as distinct cache entries', () => {
      cache.set('GPUB1', 'enc', true);
      cache.set('GPUB2', 'enc', true);
      expect(cache.get('GPUB1', 'enc')).toBe(true);
      expect(cache.get('GPUB2', 'enc')).toBe(true);
    });

    it('treats different encrypted material as distinct cache entries', () => {
      cache.set('GPUB', 'enc1', true);
      expect(cache.get('GPUB', 'enc2')).toBeUndefined();
    });
  });

  describe('invalidate', () => {
    it('removes all cached entries for a given public key', () => {
      cache.set('GPUB', 'enc-a', true);
      cache.set('GPUB', 'enc-b', true);
      cache.invalidate('GPUB');
      expect(cache.get('GPUB', 'enc-a')).toBeUndefined();
      expect(cache.get('GPUB', 'enc-b')).toBeUndefined();
    });

    it('does not remove entries for other public keys', () => {
      cache.set('GPUB1', 'enc', true);
      cache.set('GPUB2', 'enc', true);
      cache.invalidate('GPUB1');
      expect(cache.get('GPUB2', 'enc')).toBe(true);
    });

    it('is a no-op when no entries exist for the key', () => {
      expect(() => cache.invalidate('GNONE')).not.toThrow();
    });
  });

  describe('size', () => {
    it('returns 0 for an empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('counts only live (non-expired) entries', () => {
      jest.useFakeTimers();
      cache.set('GPUB1', 'enc', true, 100);
      cache.set('GPUB2', 'enc', true, 10_000);
      jest.advanceTimersByTime(200);
      expect(cache.size()).toBe(1);
    });
  });

  describe('clear', () => {
    it('removes all cached entries', () => {
      cache.set('GPUB1', 'enc', true);
      cache.set('GPUB2', 'enc', true);
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });
});

describe('KeyValidationCacheService — production/dev mode split (#689)', () => {
  describe('resolveMode', () => {
    it('defaults to "memory" outside production when unset', () => {
      expect(
        KeyValidationCacheService.resolveMode({ NODE_ENV: 'development' }),
      ).toBe('memory');
      expect(KeyValidationCacheService.resolveMode({ NODE_ENV: 'test' })).toBe(
        'memory',
      );
    });

    it('fails fast in production when unset (no silent in-process stub)', () => {
      expect(() =>
        KeyValidationCacheService.resolveMode({ NODE_ENV: 'production' }),
      ).toThrow(/must be set explicitly in production/);
    });

    it('honours an explicit mode in production', () => {
      expect(
        KeyValidationCacheService.resolveMode({
          NODE_ENV: 'production',
          KEY_VALIDATION_CACHE_MODE: 'disabled',
        }),
      ).toBe('disabled');
      expect(
        KeyValidationCacheService.resolveMode({
          NODE_ENV: 'production',
          KEY_VALIDATION_CACHE_MODE: 'MEMORY',
        }),
      ).toBe('memory');
    });

    it('rejects an unknown mode value', () => {
      expect(() =>
        KeyValidationCacheService.resolveMode({
          KEY_VALIDATION_CACHE_MODE: 'redis',
        }),
      ).toThrow(/must be one of: memory, disabled/);
    });
  });

  describe('disabled mode (fail-closed)', () => {
    let cache: KeyValidationCacheService;

    beforeEach(() => {
      cache = new KeyValidationCacheService({
        KEY_VALIDATION_CACHE_MODE: 'disabled',
      });
    });

    it('reports itself as disabled', () => {
      expect(cache.getMode()).toBe('disabled');
      expect(cache.isEnabled()).toBe(false);
    });

    it('never returns a cached result — every validation is recomputed', () => {
      cache.set('GPUB', 'enc', true, 60_000);
      expect(cache.get('GPUB', 'enc')).toBeUndefined();
      expect(cache.size()).toBe(0);
    });

    it('makes invalidate a safe no-op', () => {
      expect(() => cache.invalidate('GPUB')).not.toThrow();
    });
  });

  describe('memory mode', () => {
    it('behaves as an in-process cache', () => {
      const cache = new KeyValidationCacheService({
        KEY_VALIDATION_CACHE_MODE: 'memory',
      });
      expect(cache.getMode()).toBe('memory');
      expect(cache.isEnabled()).toBe(true);
      cache.set('GPUB', 'enc', true, 60_000);
      expect(cache.get('GPUB', 'enc')).toBe(true);
    });
  });
});
