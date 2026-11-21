import { sameKey } from './api-key-audit.service';

describe('sameKey', () => {
  it('returns true when two events describe the same presented key', () => {
    const fingerprint = 'a'.repeat(64);

    expect(sameKey(fingerprint, fingerprint)).toBe(true);
  });

  it('returns false when the fingerprints differ (different presented keys)', () => {
    const fingerprint = 'a'.repeat(64);
    const otherFingerprint = 'b'.repeat(64);

    expect(sameKey(fingerprint, otherFingerprint)).toBe(false);
  });
});
