/**
 * #694 — `validateEnv()` must reject a documented placeholder
 * `WALLET_ENCRYPTION_KEY`, and validate the optional
 * `WALLET_ENCRYPTION_KEY_PREVIOUS` (#693) used by the re-encryption job.
 *
 * Kept in its own file so these cases run under NODE_ENV=test (validateEnv
 * throws) rather than the production exit path exercised elsewhere.
 */
import { validateEnv } from './env.validation';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mux_test',
  WALLET_ENCRYPTION_KEY: 'a'.repeat(48),
  EXPORT_SIGNING_SECRET: 'b'.repeat(32),
  STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
  STELLAR_NETWORK: 'TESTNET',
};

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...BASE_ENV,
  ...overrides,
});

describe('validateEnv() — WALLET_ENCRYPTION_KEY placeholder rejection (#694)', () => {
  it('accepts a real 32+ char key', () => {
    expect(() => validateEnv(env())).not.toThrow();
  });

  it.each([
    'your-secret-encryption-key-min-32-chars',
    'your-secure-encryption-key-min-32-chars-long',
  ])('rejects the documented placeholder %p', (placeholder) => {
    expect(() =>
      validateEnv(env({ WALLET_ENCRYPTION_KEY: placeholder })),
    ).toThrow('WALLET_ENCRYPTION_KEY must not use the documented placeholder');
  });
});

describe('validateEnv() — WALLET_ENCRYPTION_KEY_PREVIOUS (#693)', () => {
  it('is optional (absent is fine)', () => {
    expect(() =>
      validateEnv(env({ WALLET_ENCRYPTION_KEY_PREVIOUS: undefined })),
    ).not.toThrow();
  });

  it('accepts a real key distinct from the current one', () => {
    expect(() =>
      validateEnv(env({ WALLET_ENCRYPTION_KEY_PREVIOUS: 'c'.repeat(40) })),
    ).not.toThrow();
  });

  it('rejects a value shorter than 32 characters', () => {
    expect(() =>
      validateEnv(env({ WALLET_ENCRYPTION_KEY_PREVIOUS: 'too-short' })),
    ).toThrow('WALLET_ENCRYPTION_KEY_PREVIOUS must be at least 32 characters');
  });

  it('rejects a value equal to the current key', () => {
    expect(() =>
      validateEnv(
        env({
          WALLET_ENCRYPTION_KEY: 'd'.repeat(48),
          WALLET_ENCRYPTION_KEY_PREVIOUS: 'd'.repeat(48),
        }),
      ),
    ).toThrow('WALLET_ENCRYPTION_KEY_PREVIOUS must differ from');
  });

  it('rejects a documented placeholder', () => {
    expect(() =>
      validateEnv(
        env({
          WALLET_ENCRYPTION_KEY_PREVIOUS:
            'your-secret-encryption-key-min-32-chars',
        }),
      ),
    ).toThrow(
      'WALLET_ENCRYPTION_KEY_PREVIOUS must not use the documented placeholder',
    );
  });

  it('is surfaced on the validated env object', () => {
    const result = validateEnv(
      env({ WALLET_ENCRYPTION_KEY_PREVIOUS: 'e'.repeat(40) }),
    );
    expect(result.WALLET_ENCRYPTION_KEY_PREVIOUS).toBe('e'.repeat(40));
  });
});
