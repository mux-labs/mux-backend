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
});
