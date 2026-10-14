import { Logger } from '@nestjs/common';
import {
  BalanceIndexerMetricsService,
  BALANCE_LAG_BREACH_METRIC,
  BALANCE_LAG_METRIC,
} from './balance-indexer-metrics.service';
import { BalanceLagCalculator } from './balance-indexer-lag';

/**
 * Lag observability: a breaching report must be visible as a distinct signal,
 * and must never carry an identifier that would blow up metric cardinality.
 */
describe('BalanceIndexerMetricsService — lag', () => {
  let service: BalanceIndexerMetricsService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new BalanceIndexerMetricsService();
    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const report = (overrides: Partial<ReturnType<typeof lag>> = {}) => ({
    ...lag(),
    ...overrides,
  });

  /** First argument of the first call, typed without leaning on `any`. */
  const firstLine = (spy: jest.SpyInstance): string =>
    (spy.mock.calls[0] as unknown[])[0] as string;

  function lag() {
    return BalanceLagCalculator.compute([], 300_000, Date.now());
  }

  it('is a no-op when a metric carries no lag', () => {
    service.recordLag({
      operation: 'sync',
      outcome: 'success',
      durationMs: 5,
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('emits a bounded bucket label, never a raw millisecond value', () => {
    service.recordLag({
      operation: 'sync',
      outcome: 'success',
      durationMs: 5,
      lag: report({ bucket: '15m', maxLagMs: 900_000 }),
    });

    const line = firstLine(logSpy);
    expect(line).toContain('bucket=15m');
    expect(line).toContain('metric=balance_indexer_lag');
    // The exact millisecond value must never be the label. It may still appear
    // as the threshold, so assert on the label position specifically.
    expect(line).not.toMatch(/bucket=900000/);
    expect(line).toContain('maxLagMs=900000');
  });

  it('does not warn for a healthy index', () => {
    service.recordLag({
      operation: 'sync',
      outcome: 'success',
      durationMs: 5,
      lag: report({ breaching: false }),
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('raises a warn carrying the breach counter name for a breaching index', () => {
    service.recordLag({
      operation: 'sync',
      outcome: 'success',
      durationMs: 5,
      lag: report({ breaching: true, bucket: '1h' }),
    });

    const line = firstLine(warnSpy);
    expect(line).toContain(BALANCE_LAG_BREACH_METRIC);
    expect(line).toContain('bucket=1h');
  });

  it('prints a saturated never-synced lag as "unbounded", not MAX_SAFE_INTEGER', () => {
    const neverSynced = BalanceLagCalculator.compute(
      [{ lastSyncedAt: null }],
      300_000,
      Date.now(),
    );

    service.recordLag({
      operation: 'detect_stale',
      outcome: 'success',
      durationMs: 5,
      lag: neverSynced,
    });

    const line = firstLine(logSpy);
    expect(line).toContain('maxLagMs=unbounded');
    expect(line).toContain('neverSynced=1');
    expect(line).not.toContain('9007199254740991');
  });

  it('exposes stable metric names', () => {
    expect(service.lagMetricName()).toBe(BALANCE_LAG_METRIC);
    expect(service.breachMetricName()).toBe(BALANCE_LAG_BREACH_METRIC);
  });
});
