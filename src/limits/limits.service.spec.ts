import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LimitsService, LimitExceededException } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService', () => {
  let service: LimitsService;
  let prisma: any;

  const walletId = 'wallet-uuid-1';

  beforeEach(async () => {
    prisma = {
      walletLimit: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      transaction: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [LimitsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<LimitsService>(LimitsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('setLimits', () => {
    it('should upsert wallet limits', async () => {
      await service.setLimits(walletId, 100, 10);
      expect(prisma.walletLimit.upsert).toHaveBeenCalledWith({
        where: { walletId },
        update: { dailyLimit: 100, perTransactionLimit: 10 },
        create: { walletId, dailyLimit: 100, perTransactionLimit: 10 },
      });
    });
  });

  describe('getLimits', () => {
    it('should return limits for a wallet', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(limit);
      const result = await service.getLimits(walletId);
      expect(result).toEqual(limit);
    });
  });

  describe('checkLimits', () => {
    it('should pass if no limits set', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.checkLimits(walletId, 100)).resolves.not.toThrow();
    });

    it('should throw if per-transaction limit exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 50,
        dailyLimit: 1000,
      });
      await expect(service.checkLimits(walletId, 100)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });

    it('should throw if daily limit exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '50' }]);
      await expect(service.checkLimits(walletId, 60)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });

    it('should pass if within limits', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '40' }]);
      await expect(service.checkLimits(walletId, 50)).resolves.not.toThrow();
    });
  });

  describe('removeLimits', () => {
    it('should delete limits for a wallet', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(limit);
      prisma.walletLimit.delete.mockResolvedValue(limit);
      await service.removeLimits(walletId);
      expect(prisma.walletLimit.delete).toHaveBeenCalledWith({ where: { walletId } });
    });

    it('should throw NotFoundException if no limits exist', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.removeLimits(walletId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
