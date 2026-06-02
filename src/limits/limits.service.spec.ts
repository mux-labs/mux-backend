import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';
import { LimitPeriod } from './dto/create-limit.dto';

const mockLimit = {
  id: 'uuid-limit-1',
  userId: 'uuid-user-1',
  perTransactionLimit: 100,
  periodLimit: 500,
  period: LimitPeriod.DAILY,
  assetCode: null,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

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

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------
  describe('create', () => {
    const dto = {
      userId: 'uuid-user-1',
      perTransactionLimit: 100,
      periodLimit: 500,
    };

    it('throws NotFoundException when user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
    });

    it('creates a spending limit for an existing user', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: dto.userId });
      prisma.spendingLimit.create.mockResolvedValue(mockLimit);

      const result = await service.create(dto);
      expect(result).toEqual(mockLimit);
      expect(prisma.spendingLimit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: dto.userId,
          perTransactionLimit: dto.perTransactionLimit,
          periodLimit: dto.periodLimit,
          period: LimitPeriod.DAILY,
          assetCode: null,
          isActive: true,
        }),
      });
    });

    it('throws ConflictException on P2002 unique constraint violation', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: dto.userId });
      prisma.spendingLimit.create.mockRejectedValue({ code: 'P2002' });
      await expect(service.create(dto)).rejects.toThrow(ConflictException);
    });

    it('re-throws unknown errors', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: dto.userId });
      prisma.spendingLimit.create.mockRejectedValue(new Error('DB error'));
      await expect(service.create(dto)).rejects.toThrow('DB error');
    });
  });

  // ---------------------------------------------------------------------------
  // findAll
  // ---------------------------------------------------------------------------
  describe('findAll', () => {
    it('returns all spending limits', async () => {
      prisma.spendingLimit.findMany.mockResolvedValue([mockLimit]);
      const result = await service.findAll();
      expect(result).toEqual([mockLimit]);
    });
  });

  // ---------------------------------------------------------------------------
  // findByUser
  // ---------------------------------------------------------------------------
  describe('findByUser', () => {
    it('returns limits for a given user', async () => {
      prisma.spendingLimit.findMany.mockResolvedValue([mockLimit]);
      const result = await service.findByUser('uuid-user-1');
      expect(prisma.spendingLimit.findMany).toHaveBeenCalledWith({
        where: { userId: 'uuid-user-1' },
      });
      expect(result).toEqual([mockLimit]);
    });
  });

  // ---------------------------------------------------------------------------
  // findOne
  // ---------------------------------------------------------------------------
  describe('findOne', () => {
    it('returns a limit by id', async () => {
      prisma.spendingLimit.findUnique.mockResolvedValue(mockLimit);
      const result = await service.findOne('uuid-limit-1');
      expect(result).toEqual(mockLimit);
    });

    it('throws NotFoundException when limit does not exist', async () => {
      prisma.spendingLimit.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // update
  // ---------------------------------------------------------------------------
  describe('update', () => {
    it('updates an existing limit', async () => {
      prisma.spendingLimit.findUnique.mockResolvedValue(mockLimit);
      const updated = { ...mockLimit, periodLimit: 1000 };
      prisma.spendingLimit.update.mockResolvedValue(updated);

      const result = await service.update('uuid-limit-1', { periodLimit: 1000 });
      expect(result).toEqual(updated);
    });

    it('throws NotFoundException when limit does not exist', async () => {
      prisma.spendingLimit.findUnique.mockResolvedValue(null);
      await expect(service.update('missing-id', {})).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // remove
  // ---------------------------------------------------------------------------
  describe('remove', () => {
    it('deletes an existing limit', async () => {
      prisma.spendingLimit.findUnique.mockResolvedValue(mockLimit);
      prisma.spendingLimit.delete.mockResolvedValue(mockLimit);

      const result = await service.remove('uuid-limit-1');
      expect(result).toEqual(mockLimit);
    });

    it('throws NotFoundException when limit does not exist', async () => {
      prisma.spendingLimit.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // Legacy: setLimits / getLimits / checkLimits
  // ---------------------------------------------------------------------------
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
      expect(prisma.walletLimit.findUnique).toHaveBeenCalledWith({ where: { walletId } });
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
      await expect(service.checkLimits(walletId, 100)).rejects.toThrow(
        'Transaction limit exceeded',
      );
    });

    it('should throw if daily limit exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '50' }]);
      await expect(service.checkLimits(walletId, 60)).rejects.toThrow(
        'Daily limit exceeded',
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

    it('should aggregate transactions by senderWalletId since start of day', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 1000,
      });
      prisma.transaction.findMany.mockResolvedValue([]);
      await service.checkLimits(walletId, 50);

      const call = prisma.transaction.findMany.mock.calls[0][0];
      expect(call.where.senderWalletId).toBe(walletId);
      expect(call.where.createdAt.gte).toBeInstanceOf(Date);
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
      await expect(service.removeLimits(walletId)).rejects.toThrow(NotFoundException);
    });
  });
});
