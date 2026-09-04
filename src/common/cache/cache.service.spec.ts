import { CacheService } from './cache.service';

describe('CacheService', () => {
  let service: CacheService;

  beforeEach(() => {
    service = new CacheService();
  });

  afterEach(() => {
    service.clear();
  });

  it('should store and retrieve a value', () => {
    const key = 'test-key';
    const value = { id: 1, name: 'test' };

    service.set(key, value);
    const retrieved = service.get<typeof value>(key);

    expect(retrieved).toEqual(value);
  });

  it('should return null for non-existent key', () => {
    const retrieved = service.get('non-existent');
    expect(retrieved).toBeNull();
  });

  it('should return null for expired entry', (done) => {
    const key = 'expiring-key';
    const value = 'expiring-value';

    service.set(key, value, 50); // 50ms TTL

    setTimeout(() => {
      const retrieved = service.get(key);
      expect(retrieved).toBeNull();
      done();
    }, 100);
  });

  it('should delete a key from cache', () => {
    const key = 'delete-key';
    service.set(key, 'value');

    expect(service.get(key)).toBe('value');
    const deleted = service.delete(key);
    expect(deleted).toBe(true);
    expect(service.get(key)).toBeNull();
  });

  it('should return false when deleting non-existent key', () => {
    const deleted = service.delete('non-existent');
    expect(deleted).toBe(false);
  });

  it('should clear all cache entries', () => {
    service.set('key1', 'value1');
    service.set('key2', 'value2');
    service.set('key3', 'value3');

    expect(service.size()).toBe(3);

    service.clear();

    expect(service.size()).toBe(0);
    expect(service.get('key1')).toBeNull();
    expect(service.get('key2')).toBeNull();
    expect(service.get('key3')).toBeNull();
  });

  it('should return correct cache size', () => {
    expect(service.size()).toBe(0);

    service.set('key1', 'value1');
    expect(service.size()).toBe(1);

    service.set('key2', 'value2');
    expect(service.size()).toBe(2);

    service.delete('key1');
    expect(service.size()).toBe(1);
  });

  it('should use default TTL of 5 minutes', (done) => {
    const key = 'default-ttl-key';
    const value = 'value';

    service.set(key, value); // No TTL specified

    // Check that value is still there after 1ms
    setTimeout(() => {
      expect(service.get(key)).toBe(value);
      done();
    }, 1);
  });

  it('should support custom TTL', (done) => {
    const key = 'custom-ttl-key';
    const value = 'value';

    service.set(key, value, 100); // 100ms TTL

    setTimeout(() => {
      expect(service.get(key)).toBeNull();
      done();
    }, 150);
  });

  it('should handle different data types', () => {
    service.set('string-key', 'string value');
    service.set('number-key', 42);
    service.set('object-key', { nested: { data: true } });
    service.set('array-key', [1, 2, 3]);

    expect(service.get('string-key')).toBe('string value');
    expect(service.get('number-key')).toBe(42);
    expect(service.get('object-key')).toEqual({ nested: { data: true } });
    expect(service.get('array-key')).toEqual([1, 2, 3]);
  });
});
