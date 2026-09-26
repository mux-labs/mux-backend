import {
  BalanceLagCalculator,
  BalanceLagErrorCode,
  BALANCE_LAG_ALERT_THRESHOLD_ENV,
  DEFAULT_LAG_ALERT_THRESHOLD_MS,
  LAG_BUCKETS,
  MAX_LAG_SCAN_ROWS,
  resolveLagThreshold,
  toLagBucket,
} from './balance-indexer-lag';

const NOW = 1_700_000_000_000;
const ago = (ms: number) => new Date(NOW - ms);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('BalanceLagCalculator', () => {
  describe('healthy index', () => {
    it('reports zero lag for rows synced right now', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: new Date(NOW) }],
        DEFAULT_LAG_ALERT_THRESHOLD_MS,
        NOW,
      );

      expect(report).toMatchObject({
        rowsScanned: 1,
        neverSynced: 0,
        maxLagMs: 0,
        bucket: '0s',
        breaching: false,
      });
    });

    it('does not breach below the threshold', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: ago(60_000) }],
        DEFAULT_LAG_ALERT_THRESHOLD_MS,
        NOW,
      );

      expect(report.breaching).toBe(false);
      expect(report.bucket).toBe('2m');
    });

    it('reports zero lag for an empty index rather than NaN', () => {
      const report = BalanceLagCalculator.compute([], 300_000, NOW);

      expect(report).toMatchObject({
        rowsScanned: 0,
        maxLagMs: 0,
        medianLagMs: 0,
        bucket: '0s',
        breaching: false,
      });
    });
  });

  describe('breaching lag', () => {
    it('breaches strictly above the threshold', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: ago(300_001) }],
        300_000,
        NOW,
      );

      expect(report.breaching).toBe(true);
      expect(report.bucket).toBe('15m');
    });

    it('does not breach exactly at the threshold', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: ago(300_000) }],
        300_000,
        NOW,
      );

      expect(report.breaching).toBe(false);
    });

    it('honours a custom threshold', () => {
      const rows = [{ lastSyncedAt: ago(90_000) }];

      expect(BalanceLagCalculator.compute(rows, 60_000, NOW).breaching).toBe(
        true,
      );
      expect(BalanceLagCalculator.compute(rows, 600_000, NOW).breaching).toBe(
        false,
      );
    });
  });

  describe('a never-synced row is maximally stale', () => {
    it('treats a missing lastSyncedAt as breaching, not fresh', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: null }],
        300_000,
        NOW,
      );

      expect(report.neverSynced).toBe(1);
      expect(report.breaching).toBe(true);
      expect(report.bucket).toBe('24h+');
    });

    it('treats an undefined lastSyncedAt the same way', () => {
      const report = BalanceLagCalculator.compute([{}], 300_000, NOW);

      expect(report.neverSynced).toBe(1);
      expect(report.breaching).toBe(true);
    });

    it('breaches the whole report even when other rows are fresh', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: new Date(NOW) }, { lastSyncedAt: null }],
        300_000,
        NOW,
      );

      expect(report.breaching).toBe(true);
      expect(report.neverSynced).toBe(1);
    });
  });

  describe('statistics', () => {
    it('computes the median of an odd number of rows', () => {
      const report = BalanceLagCalculator.compute(
        [
          { lastSyncedAt: ago(10_000) },
          { lastSyncedAt: ago(20_000) },
          { lastSyncedAt: ago(30_000) },
        ],
        300_000,
        NOW,
      );

      expect(report.medianLagMs).toBe(20_000);
      expect(report.maxLagMs).toBe(30_000);
    });

    it('computes the median of an even number of rows', () => {
      const report = BalanceLagCalculator.compute(
        [
          { lastSyncedAt: ago(10_000) },
          { lastSyncedAt: ago(20_000) },
          { lastSyncedAt: ago(30_000) },
          { lastSyncedAt: ago(40_000) },
        ],
        300_000,
        NOW,
      );

      expect(report.medianLagMs).toBe(25_000);
      expect(report.maxLagMs).toBe(40_000);
    });

    it('accepts ISO string timestamps as well as Date objects', () => {
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: new Date(NOW - 5_000).toISOString() }],
        300_000,
        NOW,
      );

      expect(report.maxLagMs).toBe(5_000);
    });
  });

  describe('adversarial input', () => {
    it('collapses a future timestamp to zero rather than going negative', () => {
      // Clock skew must not produce a negative lag or fire a bogus alert.
      const report = BalanceLagCalculator.compute(
        [{ lastSyncedAt: new Date(NOW + 60_000) }],
        300_000,
        NOW,
      );

      expect(report.maxLagMs).toBe(0);
      expect(report.bucket).toBe('0s');
      expect(report.breaching).toBe(false);
    });

    it('rejects a malformed timestamp instead of emitting NaN', () => {
      expect(
        codeOf(() =>
          BalanceLagCalculator.compute(
            [{ lastSyncedAt: 'not-a-date' }],
            300_000,
            NOW,
          ),
        ),
      ).toBe(BalanceLagErrorCode.MALFORMED_TIMESTAMP);
    });

    it('rejects a non-array input', () => {
      expect(
        codeOf(() =>
          BalanceLagCalculator.compute(undefined as never, 300_000, NOW),
        ),
      ).toBe(BalanceLagErrorCode.INVALID_INPUT);
    });

    it('bounds the scan so a huge index cannot become an outage', () => {
      const rows = Array.from({ length: MAX_LAG_SCAN_ROWS + 500 }, () => ({
        lastSyncedAt: new Date(NOW),
      }));

      expect(BalanceLagCalculator.compute(rows, 300_000, NOW).rowsScanned).toBe(
        MAX_LAG_SCAN_ROWS,
      );
    });
  });

  it('never puts an identifier in the report', () => {
    const report = BalanceLagCalculator.compute(
      [{ lastSyncedAt: ago(1_000) }],
      300_000,
      NOW,
    );

    // The report is used as metric labels and logs verbatim, so it must be a
    // fixed set of counts and durations only.
    expect(Object.keys(report).sort()).toEqual([
      'breaching',
      'bucket',
      'maxLagMs',
      'medianLagMs',
      'neverSynced',
      'rowsScanned',
      'thresholdMs',
    ]);
  });
});

describe('toLagBucket', () => {
  it.each([
    [0, '0s'],
    [1, '30s'],
    [30_000, '30s'],
    [30_001, '2m'],
    [120_000, '2m'],
    [300_000, '5m'],
    [900_000, '15m'],
    [3_600_000, '1h'],
    [21_600_000, '6h'],
    [86_400_000, '24h'],
    [86_400_001, '24h+'],
  ])('maps %ims to %s', (ms, expected) => {
    expect(toLagBucket(ms)).toBe(expected);
  });

  it('always returns a member of the fixed bucket set', () => {
    for (const ms of [-1, 0, 1e9, Number.MAX_SAFE_INTEGER, Number.NaN]) {
      expect(LAG_BUCKETS).toContain(toLagBucket(ms));
    }
  });
});

describe('resolveLagThreshold', () => {
  afterEach(() => {
    delete process.env[BALANCE_LAG_ALERT_THRESHOLD_ENV];
  });

  it('defaults when unset', () => {
    expect(resolveLagThreshold(undefined)).toBe(DEFAULT_LAG_ALERT_THRESHOLD_MS);
  });

  it('parses a valid override', () => {
    expect(resolveLagThreshold('60000')).toBe(60_000);
  });

  it.each(['abc', '0', '-1', ''])(
    'falls back to the default for the unusable value %p (fail-closed)',
    (raw) => {
      expect(resolveLagThreshold(raw)).toBe(DEFAULT_LAG_ALERT_THRESHOLD_MS);
    },
  );
});
