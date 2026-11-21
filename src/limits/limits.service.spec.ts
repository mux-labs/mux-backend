import { BadRequestException } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService.checkLimits amount validation', () => {
  let service: LimitsService;
  let prisma: {
    transaction: { findMany: jest.Mock };
    wallet: { findUnique: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      transaction: { findMany: jest.fn().mockResolvedValue([]) },
      wallet: { findUnique: jest.fn().mockResolvedValue({ dailyLimit: 1000 }) },
    };
    service = new LimitsService(prisma as unknown as PrismaService);
  });

  it.each(['NaN', 'Infinity', '-1', '0'])(
    'rejects %s with BadRequestException before querying transactions',
    async (amount) => {
      await expect(service.checkLimits('wallet-1', amount)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    },
  );

  it('continues past validation for a valid amount', async () => {
    const result = await service.checkLimits('wallet-1', '1');

    expect(result.allowed).toBe(true);
    expect(prisma.transaction.findMany).toHaveBeenCalledTimes(1);
  });
});
