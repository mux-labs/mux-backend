import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService', () => {
  let service: LimitsService;
  let prisma: {
    transaction: { findMany: jest.Mock };
    wallet: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      transaction: { findMany: jest.fn() },
      wallet: { findUnique: jest.fn() },
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
});
