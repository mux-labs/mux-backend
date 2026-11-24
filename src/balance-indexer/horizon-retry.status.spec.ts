import { isRetryableHorizonStatus } from './horizon-retry.policy';

/**
 * Regression tests for `isRetryableHorizonStatus` (#1347).
 *
 * Documented contract: 408 (request timeout), 429 (rate limited) and 5xx are
 * the only statuses a retry can plausibly fix. Every other 4xx is a
 * caller/config problem and must surface immediately — retrying it (e.g. a 404
 * for a closed account) would only amplify load against Horizon.
 */
describe('isRetryableHorizonStatus (#1347)', () => {
  const expectedRetryable = (status: number): boolean =>
    status === 408 || status === 429 || (status >= 500 && status <= 599);

  it('retries 408 and 429', () => {
    expect(isRetryableHorizonStatus(408)).toBe(true);
    expect(isRetryableHorizonStatus(429)).toBe(true);
  });

  it('retries every 5xx, including both ends of the range', () => {
    for (let status = 500; status <= 599; status += 1) {
      expect({ status, retryable: isRetryableHorizonStatus(status) }).toEqual({
        status,
        retryable: true,
      });
    }
  });

  it('never retries any other 4xx', () => {
    for (let status = 400; status <= 499; status += 1) {
      if (status === 408 || status === 429) continue;
      expect({ status, retryable: isRetryableHorizonStatus(status) }).toEqual({
        status,
        retryable: false,
      });
    }
  });

  it.each([400, 401, 403, 404, 409, 410, 422, 425])(
    'treats %i as a permanent caller/config failure',
    (status) => {
      expect(isRetryableHorizonStatus(status)).toBe(false);
    },
  );

  it('never retries informational, success or redirect statuses', () => {
    for (let status = 100; status <= 399; status += 1) {
      expect({ status, retryable: isRetryableHorizonStatus(status) }).toEqual({
        status,
        retryable: false,
      });
    }
  });

  it('does not treat statuses outside the HTTP range as 5xx', () => {
    expect(isRetryableHorizonStatus(499)).toBe(false);
    expect(isRetryableHorizonStatus(600)).toBe(false);
    expect(isRetryableHorizonStatus(999)).toBe(false);
    expect(isRetryableHorizonStatus(0)).toBe(false);
    expect(isRetryableHorizonStatus(-500)).toBe(false);
  });

  it('fails closed on non-finite input', () => {
    expect(isRetryableHorizonStatus(Number.NaN)).toBe(false);
    expect(isRetryableHorizonStatus(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isRetryableHorizonStatus(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('agrees with the documented rule across 0..999', () => {
    const mismatches: number[] = [];
    for (let status = 0; status <= 999; status += 1) {
      if (isRetryableHorizonStatus(status) !== expectedRetryable(status)) {
        mismatches.push(status);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
