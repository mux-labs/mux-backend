import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService', () => {
  let service: LimitsService;
  let prisma: {
    transaction: { findMany: jest.Mock };
    wallet: { findUnique: jest.Mock };
    walletLimit: { findUnique: jest.Mock; upsert: jest.Mock; delete: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      transaction: { findMany: jest.fn() },
      wallet: { findUnique: jest.fn() },
      walletLimit: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LimitsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<LimitsService>(LimitsService);
  });

  it('sums only parseable transaction amounts and skips unparseable rows', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      { id: 'tx-1', amount: '10' },
      { id: 'tx-2', amount: 'bogus' },
      { id: 'tx-3', amount: '5' },
    ]);

    const warnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const result = await service.checkLimits('wallet-1', 1, 100);

    expect(result.dailyUsed).toBe(15);
    expect(Number.isFinite(result.dailyUsed)).toBe(true);
    expect(Number.isFinite(result.dailyRemaining)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('tx-2'),
    );
  });

  it('still throws ForbiddenException when valid rows plus proposed amount exceed the daily limit', async () => {
    prisma.transaction.findMany.mockResolvedValue([
      { id: 'tx-1', amount: '10' },
      { id: 'tx-2', amount: 'bogus' },
      { id: 'tx-3', amount: '5' },
    ]);

    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(service.checkLimits('wallet-1', 10, 20)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('amount validation', () => {
    it.each([
      ['NaN', NaN],
      ['unparseable string', 'abc'],
      ['partially numeric string', '10abc'],
      ['negative number', -1],
      ['zero', 0],
      ['Infinity', Infinity],
    ])('rejects %s with BadRequestException and never queries Prisma', async (_label, amount) => {
      await expect(
        service.checkLimits('wallet-1', amount as number, 100),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    });

    it('allows a valid numeric amount', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);

      const result = await service.checkLimits('wallet-1', 10, 100);

      expect(result.allowed).toBe(true);
      expect(result.perTxLimit).toBe(100);
      expect(result.dailyLimit).toBe(100);
      expect(result.dailyUsed).toBe(0);
      expect(result.dailyRemaining).toBe(100);
    });

    it('allows a valid numeric string amount', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);

      const result = await service.checkLimits('wallet-1', '10.5' as unknown as number, 100);

      expect(result.allowed).toBe(true);
      expect(result.perTxLimit).toBe(100);
      expect(result.dailyLimit).toBe(100);
      expect(result.dailyUsed).toBe(0);
      expect(result.dailyRemaining).toBe(100);
    });
  });

  describe('setLimits', () => {
    it('upserts valid limits with both update and create branches', async () => {
      prisma.walletLimit.upsert.mockResolvedValue({
        walletId: 'wallet-1',
        dailyLimit: 100,
        perTransactionLimit: 10,
      });

      await service.setLimits('wallet-1', 100, 10);

      expect(prisma.walletLimit.upsert).toHaveBeenCalledWith({
        where: { walletId: 'wallet-1' },
        update: { dailyLimit: 100, perTransactionLimit: 10 },
        create: {
          walletId: 'wallet-1',
          dailyLimit: 100,
          perTransactionLimit: 10,
        },
      });
    });

    it.each([
      ['negative daily', -1, 10],
      ['negative perTx', 10, -1],
      ['NaN daily', NaN, 10],
      ['NaN perTx', 10, NaN],
      ['Infinity daily', Infinity, 10],
      ['Infinity perTx', 10, Infinity],
    ])('rejects %s with BadRequestException and never calls upsert', async (_label, daily, perTx) => {
      await expect(
        service.setLimits('wallet-1', daily as number, perTx as number),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.walletLimit.upsert).not.toHaveBeenCalled();
    });
  });

  describe('getLimits', () => {
    it('returns the row for a known wallet', async () => {
      const row = {
        walletId: 'wallet-1',
        dailyLimit: 100,
        perTransactionLimit: 10,
      };
      prisma.walletLimit.findUnique.mockResolvedValue(row);

      await expect(service.getLimits('wallet-1')).resolves.toEqual(row);
      expect(prisma.walletLimit.findUnique).toHaveBeenCalledWith({
        where: { walletId: 'wallet-1' },
      });
    });

    it('returns null for an unknown wallet', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);

      await expect(service.getLimits('missing')).resolves.toBeNull();
    });
  });

  describe('removeLimits', () => {
    it('throws NotFoundException when no row exists', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);

      await expect(service.removeLimits('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.walletLimit.delete).not.toHaveBeenCalled();
    });

    it('deletes the row when it exists', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        walletId: 'wallet-1',
        dailyLimit: 100,
        perTransactionLimit: 10,
      });
      prisma.walletLimit.delete.mockResolvedValue({
        walletId: 'wallet-1',
        dailyLimit: 100,
        perTransactionLimit: 10,
      });

      await service.removeLimits('wallet-1');

      expect(prisma.walletLimit.delete).toHaveBeenCalledWith({
        where: { walletId: 'wallet-1' },
      });
    });
  });
});
