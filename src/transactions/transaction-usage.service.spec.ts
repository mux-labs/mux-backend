import {
  addAmounts,
  MAX_WALLET_ID_LENGTH,
  UsageErrorCode,
  UsageService,
  UsageUnavailableError,
  UsageStatus,
  utcDayWindow,
} from './transaction-usage.service';
import type { UsageAggregateRow } from './transaction-usage.service';
import { MetricsService } from '../common/metrics/metrics.service';

const WALLET = 'wallet-1';
/** Mid-day on purpose, so an off-by-one in the window truncation is visible. */
const NOW = new Date('2026-03-04T12:34:56.000Z');

function row(
  assetCode: string,
  amount: string | null,
  count = 1,
): UsageAggregateRow {
  return {
    assetCode,
    amount,
    _sum: { amount },
    _count: { _all: count },
  };
}

function build(groupBy: jest.Mock) {
  const metrics = { incrementCounter: jest.fn() } as unknown as MetricsService;
  return {
    service: new UsageService({ transaction: { groupBy } }, metrics),
    metrics: metrics as unknown as { incrementCounter: jest.Mock },
  };
}

/** The single `groupBy` call's arguments, typed so assertions read clearly. */
function groupByArgs(groupBy: jest.Mock): {
  by: string[];
  where: Record<string, never>;
  _sum: Record<string, true>;
  _count: { _all: true };
} {
  const calls = groupBy.mock.calls as unknown as [Record<string, never>][][];
  return calls[0][0] as unknown as {
    by: string[];
    where: Record<string, never>;
    _sum: Record<string, true>;
    _count: { _all: true };
  };
}

/** Asserts `run` rejects with the given stable code. */
async function expectCode(
  run: () => unknown,
  code: string,
): Promise<UsageUnavailableError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(UsageUnavailableError);
    expect((err as UsageUnavailableError).code).toBe(code);
    return err as UsageUnavailableError;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe('utcDayWindow', () => {
  it('truncates to the UTC calendar day, inclusive start', () => {
    const { start, end } = utcDayWindow(NOW);
    expect(start.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-05T00:00:00.000Z');
  });

  it('is unaffected by the caller timezone offset', () => {
    // The window must be decided in UTC so two operators see the same limit.
    const { start } = utcDayWindow(new Date('2026-03-04T23:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('handles a leap day', () => {
    const { end } = utcDayWindow(new Date('2028-02-29T10:00:00.000Z'));
    expect(end.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('refuses an invalid clock rather than returning a wrong window', () => {
    expect(() => utcDayWindow(new Date('nope'))).toThrow(UsageUnavailableError);
  });
});

describe('addAmounts', () => {
  it.each([
    [undefined, '1.5', '1.5'],
    ['1.5', '2.25', '3.75'],
    ['0.1', '0.2', '0.3'],
    ['1', '2', '3'],
    ['1.10', '2.5', '3.6'],
    ['9007199254740993', '1', '9007199254740994'],
  ])('adds %p + %p as %p', (a, b, expected) => {
    expect(addAmounts(a, b)).toBe(expected);
  });

  it('keeps precision a JS number would lose', () => {
    // 2^53 + 1 is not representable as a Number; the sum must still be exact.
    expect(addAmounts('9007199254740992', '1')).toBe('9007199254740993');
    expect(String(Number('9007199254740992') + 1)).not.toBe('9007199254740993');
  });
});

describe('UsageService.getTodayUsage', () => {
  describe('authoritative aggregation', () => {
    it('sums per-asset amounts over the UTC day', async () => {
      const groupBy = jest
        .fn()
        .mockResolvedValue([row('XLM', '10.5', 2), row('USDC', '3.25', 1)]);
      const { service } = build(groupBy);

      const usage = await service.getTodayUsage(WALLET, NOW);

      expect(usage.amounts).toEqual({ XLM: '10.5', USDC: '3.25' });
      expect(usage.transactionCount).toBe(3);
      expect(usage.windowStart).toBe('2026-03-04T00:00:00.000Z');
      expect(usage.windowEnd).toBe('2026-03-05T00:00:00.000Z');
      expect(usage.computedAt).toBe(NOW.toISOString());
    });

    it('queries only the caller wallet, in the current UTC window', async () => {
      const groupBy = jest.fn().mockResolvedValue([]);
      const { service } = build(groupBy);

      await service.getTodayUsage(WALLET, NOW);

      const { where } = groupByArgs(groupBy);
      expect(where.senderWalletId).toBe(WALLET);
      const window = where.createdAt as unknown as {
        gte: Date;
        lt: Date;
      };
      expect(window.gte.toISOString()).toBe('2026-03-04T00:00:00.000Z');
      expect(window.lt.toISOString()).toBe('2026-03-05T00:00:00.000Z');
    });

    it('never lets the caller supply the window or the total', async () => {
      const groupBy = jest.fn().mockResolvedValue([]);
      const { service } = build(groupBy);

      await service.getTodayUsage(WALLET, NOW);

      const args = groupByArgs(groupBy);
      expect(args.by).toEqual(['assetCode']);
      expect(args._sum).toEqual({ amount: true });
      expect(args.where).not.toHaveProperty('amount');
    });

    it('counts PENDING and CONFIRMED but not FAILED', async () => {
      const groupBy = jest.fn().mockResolvedValue([]);
      const { service } = build(groupBy);

      await service.getTodayUsage(WALLET, NOW);

      const status = groupByArgs(groupBy).where.status as unknown as {
        in: string[];
      };
      expect(status.in.sort()).toEqual(
        [UsageStatus.PENDING, UsageStatus.CONFIRMED].sort(),
      );
      expect(status.in).not.toContain(UsageStatus.FAILED);
    });

    it('returns an empty, honest zero when nothing was spent', async () => {
      const groupBy = jest.fn().mockResolvedValue([]);
      const { service } = build(groupBy);

      const usage = await service.getTodayUsage(WALLET, NOW);

      expect(usage.amounts).toEqual({});
      expect(usage.transactionCount).toBe(0);
    });

    it('ignores an empty aggregate group rather than reporting NaN', async () => {
      const groupBy = jest.fn().mockResolvedValue([row('XLM', null, 0)]);
      const { service } = build(groupBy);

      const usage = await service.getTodayUsage(WALLET, NOW);

      expect(usage.amounts).toEqual({});
    });
  });

  describe('fail closed', () => {
    it('refuses an unusable wallet id before touching the store', async () => {
      const groupBy = jest.fn();
      const { service } = build(groupBy);

      await expectCode(
        () => service.getTodayUsage('', NOW),
        UsageErrorCode.INVALID_WALLET_ID,
      );
      await expectCode(
        () => service.getTodayUsage('a'.repeat(MAX_WALLET_ID_LENGTH + 1), NOW),
        UsageErrorCode.INVALID_WALLET_ID,
      );
      expect(groupBy).not.toHaveBeenCalled();
    });

    it('raises instead of reporting zero when the store is down', async () => {
      const groupBy = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const { service, metrics } = build(groupBy);

      await expectCode(
        () => service.getTodayUsage(WALLET, NOW),
        UsageErrorCode.STORE_UNAVAILABLE,
      );
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'usage_store_unavailable',
      );
    });

    it('rejects a non-array store result', async () => {
      const groupBy = jest.fn().mockResolvedValue({ nope: true });
      const { service } = build(groupBy);

      await expectCode(
        () => service.getTodayUsage(WALLET, NOW),
        UsageErrorCode.STORE_CONTRACT_VIOLATION,
      );
    });

    it.each([
      [
        'a negative amount',
        {
          assetCode: 'XLM',
          _sum: { amount: '-1.0' },
        } as unknown as UsageAggregateRow,
      ],
      [
        'a non-numeric amount',
        {
          assetCode: 'XLM',
          _sum: { amount: 'lots' },
        } as unknown as UsageAggregateRow,
      ],
      [
        'a row with no asset code',
        {
          assetCode: '',
          _sum: { amount: '1' },
        } as unknown as UsageAggregateRow,
      ],
    ])('refuses %s rather than coercing it', async (_label, badRow) => {
      const groupBy = jest.fn().mockResolvedValue([badRow]);
      const { service } = build(groupBy);

      await expectCode(
        () => service.getTodayUsage(WALLET, NOW),
        UsageErrorCode.STORE_CONTRACT_VIOLATION,
      );
    });
  });

  describe('no PII in errors', () => {
    it('does not leak the wallet id or the store error text', async () => {
      const groupBy = jest.fn().mockRejectedValue(new Error('boom'));
      const { service } = build(groupBy);

      const err = await expectCode(
        () => service.getTodayUsage(WALLET, NOW),
        UsageErrorCode.STORE_UNAVAILABLE,
      );

      expect(err.message).not.toContain(WALLET);
      expect(err.message).not.toContain('boom');
    });
  });
});
