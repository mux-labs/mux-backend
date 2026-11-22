import {
  BadRequestException,
  ForbiddenException,
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
import type { BalanceActor } from './balance-indexer.model';
import { MetricsService } from '../common/metrics/metrics.service';

const WALLET = 'wallet-1';
const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const OPERATOR: BalanceActor = {
  subjectId: 'ops-1',
  role: 'operator',
  correlationId: 'test-correlation',
};

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

  describe('enforceAuthorization', () => {
    const OWNER: BalanceActor = {
      subjectId: 'owner-1',
      role: 'user',
      correlationId: 'test-correlation',
    };
    const FOREIGN: BalanceActor = {
      subjectId: 'stranger-1',
      role: 'user',
      correlationId: 'test-correlation',
    };

    it('allows an operator through the no-walletId (sweep/write) gate', async () => {
      await expect(
        service.enforceAuthorization(OPERATOR),
      ).resolves.toBeUndefined();
    });

    it('denies a non-operator through the no-walletId gate', async () => {
      await expect(service.enforceAuthorization(OWNER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('denies an unauthenticated actor through the no-walletId gate', async () => {
      await expect(
        service.enforceAuthorization(undefined as unknown as BalanceActor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows the wallet owner through the wallet-scoped gate', async () => {
      prisma.wallet.findUnique.mockResolvedValue({
        id: WALLET,
        publicKey: ACCOUNT,
        ownerSubjectId: OWNER.subjectId,
      });

      await expect(
        service.enforceAuthorization(OWNER, WALLET),
      ).resolves.toBeUndefined();
    });

    it('allows an operator through the wallet-scoped gate', async () => {
      prisma.wallet.findUnique.mockResolvedValue({
        id: WALLET,
        publicKey: ACCOUNT,
        ownerSubjectId: OWNER.subjectId,
      });

      await expect(
        service.enforceAuthorization(OPERATOR, WALLET),
      ).resolves.toBeUndefined();
    });

    it('denies a foreign actor through the wallet-scoped gate', async () => {
      prisma.wallet.findUnique.mockResolvedValue({
        id: WALLET,
        publicKey: ACCOUNT,
        ownerSubjectId: OWNER.subjectId,
      });

      await expect(
        service.enforceAuthorization(FOREIGN, WALLET),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('denies a missing wallet exactly like a foreign one', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.enforceAuthorization(OWNER, WALLET),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolves ownership from the stored row, not a caller-supplied claim', async () => {
      // The actor claims to own the wallet, but the stored row says otherwise.
      prisma.wallet.findUnique.mockResolvedValue({
        id: WALLET,
        publicKey: ACCOUNT,
        ownerSubjectId: 'someone-else',
      });

      const claimant: BalanceActor = {
        subjectId: WALLET,
        role: 'user',
        correlationId: 'test-correlation',
      };

      await expect(
        service.enforceAuthorization(claimant, WALLET),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('fail-closed writes', () => {
    it('refuses to write when BALANCE_SYNC_ENABLED is unset', async () => {
      delete process.env[BALANCE_SYNC_ENABLED_ENV];

      await expect(
        service.syncWalletBalances(OPERATOR, { walletId: WALLET }),
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

      await expect(service.getAllBalances(OPERATOR, WALLET)).resolves.toHaveLength(1);
    });
  });

  describe('Horizon outage (fail-closed)', () => {
    it('throws a stable error and writes nothing when Horizon is down', async () => {
      horizon.fetchAccountBalances.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.syncWalletBalances(OPERATOR, { walletId: WALLET, forceRefresh: true }),
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
        service.syncWalletBalances(OPERATOR, { walletId: WALLET, forceRefresh: true }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(prisma.walletBalance.upsert).not.toHaveBeenCalled();
    });

    it('surfaces a store outage as 503 without leaking driver detail', async () => {
      prisma.wallet.findUnique.mockRejectedValue(
        new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      );

      await expect(
        service.syncWalletBalances(OPERATOR, { walletId: WALLET, forceRefresh: true }),
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

      const result = await service.reconcileBalance(OPERATOR, WALLET, { type: 'NATIVE' });

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

      const result = await service.reconcileBalance(OPERATOR, WALLET, { type: 'NATIVE' });
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

      const result = await service.reconcileBalance(OPERATOR, WALLET, { type: 'NATIVE' });

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

      const result = await service.reconcileBalance(OPERATOR, WALLET, {
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

      const result = await service.reconcileBalance(OPERATOR, WALLET, { type: 'NATIVE' });

      expect(result.matches).toBe(false);
      expect(result.indexedBalance).toBeNull();
      expect(createArgs[0]).toBeDefined();
    });
  });
});
