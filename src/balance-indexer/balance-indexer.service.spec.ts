import { BalanceIndexerService } from './balance-indexer.service';

describe('BalanceIndexerService.isRetryable', () => {
  const service = Object.create(
    BalanceIndexerService.prototype,
  ) as BalanceIndexerService;

  const isRetryable = (status: number): boolean =>
    (service as unknown as { isRetryable(status: number): boolean }).isRetryable(
      status,
    );

  it('retries 503 (dependency-unavailable envelope and upstream 5xx)', () => {
    expect(isRetryable(503)).toBe(true);
  });

  it('retries 429 (rate limiting)', () => {
    expect(isRetryable(429)).toBe(true);
  });

  it('does not retry 4xx errors (bad input, disabled feature, not found)', () => {
    expect(isRetryable(400)).toBe(false);
    expect(isRetryable(403)).toBe(false);
    expect(isRetryable(404)).toBe(false);
  });
});
