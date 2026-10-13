import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from './limits.service';

describe('LimitsService (#1102)', () => {
  const walletId = 'wallet-1';
  let service: LimitsService;
  let prisma: {
    walletLimit: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      walletLimit: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
    };

    service = new LimitsService(prisma as unknown as PrismaService);
  });

  describe('setLimits', () => {
    it('upserts valid limits in both the update and create branches', async () => {
      const row = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.upsert.mockResolvedValue(row);

      await expect(service.setLimits(walletId, 100, 10)).resolves.toBe(row);
      expect(prisma.walletLimit.upsert).toHaveBeenCalledWith({
        where: { walletId },
        update: { dailyLimit: 100, perTransactionLimit: 10 },
        create: { walletId, dailyLimit: 100, perTransactionLimit: 10 },
      });
    });

    it('accepts zero limits', async () => {
      await service.setLimits(walletId, 0, 0);
      expect(prisma.walletLimit.upsert).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['negative daily', -1, 10, 'daily'],
      ['negative perTx', 10, -1, 'perTx'],
      ['NaN daily', NaN, 10, 'daily'],
      ['NaN perTx', 10, NaN, 'perTx'],
      ['Infinity daily', Infinity, 10, 'daily'],
      ['-Infinity perTx', 10, -Infinity, 'perTx'],
    ])(
      'rejects %s with BadRequestException before touching Prisma',
      async (_label, daily, perTx, field) => {
        const call = service.setLimits(walletId, daily, perTx);
        await expect(call).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.setLimits(walletId, daily, perTx)).rejects.toThrow(
          field,
        );
        expect(prisma.walletLimit.upsert).not.toHaveBeenCalled();
      },
    );
  });

  describe('getLimits', () => {
    it('returns the stored row', async () => {
      const row = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(row);

      await expect(service.getLimits(walletId)).resolves.toBe(row);
      expect(prisma.walletLimit.findUnique).toHaveBeenCalledWith({
        where: { walletId },
      });
    });

    it('returns null for an unknown wallet', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.getLimits('unknown')).resolves.toBeNull();
    });
  });

  describe('removeLimits', () => {
    it('throws NotFoundException and does not delete when no row exists', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);

      await expect(service.removeLimits(walletId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.walletLimit.delete).not.toHaveBeenCalled();
    });

    it('deletes the row when it exists', async () => {
      const row = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(row);
      prisma.walletLimit.delete.mockResolvedValue(row);

      await expect(service.removeLimits(walletId)).resolves.toBe(row);
      expect(prisma.walletLimit.delete).toHaveBeenCalledWith({
        where: { walletId },
      });
    });
  });
});
