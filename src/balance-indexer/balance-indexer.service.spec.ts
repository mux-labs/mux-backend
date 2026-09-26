import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BalanceIndexerService } from './balance-indexer.service';
import {
  BalanceIndexerErrorCode,
  BALANCE_SYNC_ENABLED_ENV,
} from './balance-indexer.error-codes';
import type { HorizonAccountBalances } from './balance-indexer.error-codes';
import { MetricsService } from '../common/metrics/metrics.service';

const WALLET = 'wallet-1';
const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function snapshot(
  balances: HorizonAccountBalances['balances'],
): HorizonAccountBalances {
  return { accountId: ACCOUNT, ledger: 42, balances };
}

function native(balance: string) {
  return {
    assetType: 'NATIVE' as const,
    assetCode: null,
    assetIssuer: null,
    balance,
  };
}

describe('BalanceIndexerService', () => {
  let service: BalanceIndexerService;
  let prisma: {
    wallet: { findUnique: jest.Mock; findMany: jest.Mock };
    walletBalance: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
      upsert: jest.Mock;
      update: jest.Mock;
      create: jest.Mock;
    };
  };
  let horizon: { fetchAccountBalances: jest.Mock };
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    process.env[BALANCE_SYNC_ENABLED_ENV] = 'true';

    prisma = {
      wallet: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: WALLET, publicKey: ACCOUNT }),
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: WALLET, publicKey: ACCOUNT }]),
      },
      walletBalance: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    horizon = {
      fetchAccountBalances: jest
        .fn()
        .mockResolvedValue(snapshot([native('100')])),
    };
    metrics = { incrementCounter: jest.fn() };

    service = new BalanceIndexerService(
      prisma,
      metrics as unknown as MetricsService,
      horizon,
    );
  });

  afterEach(() => {
    delete process.env[BALANCE_SYNC_ENABLED_ENV];
    delete process.env.BALANCE_STALE_THRESHOLD_MS;
    jest.restoreAllMocks();
  });

  describe('fail-closed writes', () => {
    it('refuses to write when BALANCE_SYNC_ENABLED is unset', async () => {
      delete process.env[BALANCE_SYNC_ENABLED_ENV];

      await expect(
        service.syncWalletBalances({ walletId: WALLET }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      // Nothing may be persisted when the kill-switch is off.
      expect(prisma.walletBalance.upsert).not.toHaveBeenCalled();
    });

    it('treats a non-truthy flag value as disabled', () => {
      process.env[BALANCE_SYNC_ENABLED_ENV] = 'yes';
      expect(service.isBalanceSyncEnabled()).toBe(false);
    });

    it('still serves reads while writes are disabled', async () => {
      delete process.env[BALANCE_SYNC_ENABLED_ENV];
      prisma.walletBalance.findMany.mockResolvedValue([
        { ...native('5'), walletId: WALLET },
      ] as never);

      await expect(service.getAllBalances(WALLET)).resolves.toHaveLength(1);
    });
  });

  describe('Horizon outage (fail-closed)', () => {
    it('throws a stable error and writes nothing when Horizon is down', async () => {
      horizon.fetchAccountBalances.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.syncWalletBalances({ walletId: WALLET, forceRefresh: true }),
      ).rejects.toMatchObject({
        response: { code: BalanceIndexerErrorCode.DEPENDENCY_UNAVAILABLE },
      });

      expect(prisma.walletBalance.upsert).not.toHaveBeenCalled();
    });

    it('rejects a malformed Horizon payload rather than treating it as empty', async () => {
      // A payload without `balances` must not be persisted as "holds nothing".
      horizon.fetchAccountBalances.mockResolvedValue({
        accountId: ACCOUNT,
        ledger: 1,
      });

      await expect(
        service.syncWalletBalances({ walletId: WALLET, forceRefresh: true }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(prisma.walletBalance.upsert).not.toHaveBeenCalled();
    });

    it('surfaces a store outage as 503 without leaking driver detail', async () => {
      prisma.wallet.findUnique.mockRejectedValue(
        new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      );

      await expect(
        service.syncWalletBalances({ walletId: WALLET, forceRefresh: true }),
      ).rejects.toMatchObject({
        response: { code: BalanceIndexerErrorCode.DEPENDENCY_UNAVAILABLE },
      });
    });
  });

  describe('reconciliation', () => {
    it('reports a match when indexed and on-chain balances agree', async () => {
      prisma.walletBalance.findUnique.mockResolvedValue({
        id: 'b1',
        balance: '100.0000000',
      });

      const result = await service.reconcileBalance(WALLET, { type: 'NATIVE' });

      expect(result.matches).toBe(true);
      expect(result.indexedBalance).toBe('100.0000000');
      expect(result.onChainBalance).toBe('100');
    });

    it('does not report a mismatch for an equivalent decimal formatting', async () => {
      // "100.0" and "100" are the same amount; flagging this would be noise.
      prisma.walletBalance.findUnique.mockResolvedValue({
        id: 'b1',
        balance: '100.0',
      });

      const result = await service.reconcileBalance(WALLET, { type: 'NATIVE' });
      expect(result.matches).toBe(true);
    });

    it('flags a real mismatch and marks the row without overwriting the indexed value', async () => {
      const updateArgs: Array<Record<string, unknown>> = [];
      prisma.walletBalance.update.mockImplementation(
        (args: Record<string, unknown>) => {
          updateArgs.push(args);
          return Promise.resolve({});
        },
      );
      prisma.walletBalance.findUnique.mockResolvedValue({
        id: 'b1',
        balance: '50',
      });

      const result = await service.reconcileBalance(WALLET, { type: 'NATIVE' });

      expect(result.matches).toBe(false);
      expect(result.indexedBalance).toBe('50');
      expect(result.onChainBalance).toBe('100');

      const updateArg = updateArgs[0] as { data: Record<string, unknown> };
      expect(updateArg.data.syncStatus).toBe('MISMATCH');
      // The indexed balance must be preserved — an operator decides which is right.
      expect(updateArg.data.balance).toBeUndefined();
    });

    it('scopes the on-chain lookup to the requested asset', async () => {
      horizon.fetchAccountBalances.mockResolvedValue(
        snapshot([
          native('100'),
          {
            assetType: 'CREDIT_ALPHANUM4' as const,
            assetCode: 'USDC',
            assetIssuer: 'GISSUER',
            balance: '7',
          },
        ]),
      );
      prisma.walletBalance.findUnique.mockResolvedValue({
        id: 'b2',
        balance: '7',
      });

      const result = await service.reconcileBalance(WALLET, {
        type: 'CREDIT_ALPHANUM4',
        code: 'USDC',
        issuer: 'GISSUER',
      });

      expect(result.onChainBalance).toBe('7');
      expect(result.matches).toBe(true);
    });

    it('seeds a MISMATCH row for an asset that was never indexed', async () => {
      const createArgs: Array<Record<string, unknown>> = [];
      prisma.walletBalance.create.mockImplementation(
        (args: Record<string, unknown>) => {
          createArgs.push(args);
          return Promise.resolve({});
        },
      );
      prisma.walletBalance.findUnique.mockResolvedValue(null);

      const result = await service.reconcileBalance(WALLET, { type: 'NATIVE' });

      expect(result.matches).toBe(false);
      const createArg = createArgs[0] as { data: Record<string, unknown> };
      expect(createArg.data.syncStatus).toBe('MISMATCH');
      expect(createArg.data.onChainBalance).toBe('100');
    });

    it('404s for an unknown wallet instead of reconciling nothing', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.reconcileBalance('missing', { type: 'NATIVE' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(horizon.fetchAccountBalances).not.toHaveBeenCalled();
    });
  });

  describe('idempotency / replay', () => {
    it('skips the Horizon round-trip when the balance is already fresh', async () => {
      prisma.walletBalance.count.mockResolvedValue(1);

      const result = await service.syncWalletBalances({ walletId: WALLET });

      expect(result.balancesUpdated).toBe(0);
      expect(horizon.fetchAccountBalances).not.toHaveBeenCalled();
    });

    it('is idempotent: repeating a forced sync converges on the same state', async () => {
      const first = await service.syncWalletBalances({
        walletId: WALLET,
        forceRefresh: true,
      });
      const second = await service.syncWalletBalances({
        walletId: WALLET,
        forceRefresh: true,
      });

      expect(second.balancesUpdated).toBe(first.balancesUpdated);
      // Upserts, not creates — a replay must not duplicate balance rows.
      expect(prisma.walletBalance.create).not.toHaveBeenCalled();
    });

    it('re-running a reconciliation on unchanged data is a no-op match', async () => {
      prisma.walletBalance.findUnique.mockResolvedValue({
        id: 'b1',
        balance: '100',
      });

      const first = await service.reconcileBalance(WALLET, { type: 'NATIVE' });
      const second = await service.reconcileBalance(WALLET, { type: 'NATIVE' });

      expect(first).toEqual(second);
    });
  });

  describe('retry policy', () => {
    it('retries a transient Horizon outage and succeeds', async () => {
      horizon.fetchAccountBalances
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce(snapshot([native('100')]));

      const result = await service.syncWalletBalancesWithRetry({
        walletId: WALLET,
        forceRefresh: true,
      });

      expect(result.balancesUpdated).toBe(1);
      expect(horizon.fetchAccountBalances).toHaveBeenCalledTimes(2);
    });

    it('gives up after the attempt budget instead of retrying forever', async () => {
      horizon.fetchAccountBalances.mockRejectedValue(new Error('timeout'));

      await expect(
        service.syncWalletBalancesWithRetry({
          walletId: WALLET,
          forceRefresh: true,
          maxAttempts: 2,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(horizon.fetchAccountBalances).toHaveBeenCalledTimes(2);
    });

    it('does not retry a permanent failure', async () => {
      // A 404 will never succeed on retry, so retrying only amplifies load.
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.syncWalletBalancesWithRetry({
          walletId: 'missing',
          maxAttempts: 3,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(horizon.fetchAccountBalances).not.toHaveBeenCalled();
    });
  });

  describe('adversarial input', () => {
    it('rejects a wallet id that could be used for log injection', async () => {
      await expect(
        service.getAllBalances('wallet\nlevel=ERROR'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.walletBalance.findMany).not.toHaveBeenCalled();
    });

    it('rejects an oversized wallet id', async () => {
      await expect(
        service.getAllBalances('a'.repeat(129)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('fails closed on an oversized sweep rather than silently truncating', async () => {
      prisma.wallet.findMany.mockResolvedValue(
        Array.from({ length: 501 }, (_, i) => ({
          id: `w${i}`,
          publicKey: ACCOUNT,
        })),
      );

      await expect(service.syncAllWallets()).rejects.toBeInstanceOf(
        PayloadTooLargeException,
      );
    });
  });

  describe('staleness detection', () => {
    it('reports never-synced rows as stale', async () => {
      prisma.walletBalance.findMany.mockResolvedValue([
        {
          assetType: 'NATIVE',
          assetCode: null,
          assetIssuer: null,
          lastSyncedAt: null,
        },
      ] as never);

      const report = await service.detectStaleBalances(WALLET);
      expect(report.staleAssets).toHaveLength(1);
      expect(report.staleSince).toBeNull();
    });

    it('reports rows older than the threshold as stale', async () => {
      process.env.BALANCE_STALE_THRESHOLD_MS = '1000';
      prisma.walletBalance.findMany.mockResolvedValue([
        {
          assetType: 'NATIVE',
          assetCode: null,
          assetIssuer: null,
          lastSyncedAt: new Date(Date.now() - 60_000),
        },
      ] as never);

      const report = await service.detectStaleBalances(WALLET);
      expect(report.staleAssets).toHaveLength(1);
      expect(report.staleSince).toBeInstanceOf(Date);
    });

    it('does not report a recently synced row as stale', async () => {
      process.env.BALANCE_STALE_THRESHOLD_MS = '600000';
      prisma.walletBalance.findMany.mockResolvedValue([
        {
          assetType: 'NATIVE',
          assetCode: null,
          assetIssuer: null,
          lastSyncedAt: new Date(),
        },
      ] as never);

      const report = await service.detectStaleBalances(WALLET);
      expect(report.staleAssets).toHaveLength(0);
    });
  });

  describe('scheduled sweep', () => {
    it('keeps going when one wallet fails and counts the failure', async () => {
      prisma.wallet.findMany.mockResolvedValue([
        { id: 'bad', publicKey: ACCOUNT },
        { id: 'good', publicKey: ACCOUNT },
      ] as never);
      prisma.wallet.findUnique.mockImplementation(
        (args: { where: { id: string } }) =>
          Promise.resolve(
            args.where.id === 'bad' ? null : { id: 'good', publicKey: ACCOUNT },
          ),
      );

      await expect(service.runScheduledSync()).resolves.toBeUndefined();

      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'balance_scheduled_sync_failed',
      );
    });
  });

  describe('observability', () => {
    it('never logs a full account id', async () => {
      const logSpy = jest
        .spyOn(
          (service as unknown as { logger: { error: (m: string) => void } })
            .logger,
          'error',
        )
        .mockImplementation(() => undefined);
      horizon.fetchAccountBalances.mockRejectedValue(new Error('down'));

      await expect(
        service.syncWalletBalances({ walletId: WALLET, forceRefresh: true }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const logged = logSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain(ACCOUNT);
    });

    it('emits a mismatch metric on a discrepancy', async () => {
      prisma.walletBalance.findUnique.mockResolvedValue({
        id: 'b1',
        balance: '1',
      });

      await service.reconcileBalance(WALLET, { type: 'NATIVE' });

      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'balance_reconcile_mismatch',
      );
    });
  });
});
