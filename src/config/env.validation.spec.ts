import { validate } from './env.validation';

describe('env validation', () => {
  const baseEnv = {
    NODE_ENV: 'test',
  };

  it('applies idempotency cleanup defaults when the variables are absent', () => {
    const config = validate({ ...baseEnv });

    expect(config.IDEMPOTENCY_CLEANUP_ENABLED).toBe(false);
    expect(config.IDEMPOTENCY_CLEANUP_INTERVAL_MS).toBe(3_600_000);
    expect(config.IDEMPOTENCY_CLEANUP_BATCH_SIZE).toBe(1000);
  });

  it('rejects a non-numeric IDEMPOTENCY_CLEANUP_INTERVAL_MS', () => {
    expect(() =>
      validate({
        ...baseEnv,
        IDEMPOTENCY_CLEANUP_INTERVAL_MS: 'not-a-number',
      }),
    ).toThrow(/IDEMPOTENCY_CLEANUP_INTERVAL_MS/);
  });

  it('rejects a non-numeric IDEMPOTENCY_CLEANUP_BATCH_SIZE', () => {
    expect(() =>
      validate({
        ...baseEnv,
        IDEMPOTENCY_CLEANUP_BATCH_SIZE: 'not-a-number',
      }),
    ).toThrow(/IDEMPOTENCY_CLEANUP_BATCH_SIZE/);
  });

  describe('MAINNET_PAYMENT_ENABLED', () => {
    it('defaults to false when absent', () => {
      const config = validate({ ...baseEnv });

      expect(config.MAINNET_PAYMENT_ENABLED).toBe(false);
    });

    it.each(['true', '1', 'on'])('parses %s as true', (value) => {
      const config = validate({ ...baseEnv, MAINNET_PAYMENT_ENABLED: value });

      expect(config.MAINNET_PAYMENT_ENABLED).toBe(true);
    });

    it.each(['false', '0', 'off'])('parses %s as false', (value) => {
      const config = validate({ ...baseEnv, MAINNET_PAYMENT_ENABLED: value });

      expect(config.MAINNET_PAYMENT_ENABLED).toBe(false);
    });

    it('throws naming the variable for an unrecognized value', () => {
      expect(() =>
        validate({ ...baseEnv, MAINNET_PAYMENT_ENABLED: 'maybe' }),
      ).toThrow(/MAINNET_PAYMENT_ENABLED/);
    });
  });
});
