import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LimitsService, LimitExceededException } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { LimitUpdatedEvent } from './events/limit-updated.event';
import { LimitExceededEvent } from './events/limit-exceeded.event';

describe('LimitsService', () => {
  let service: LimitsService;
  let prisma: any;
  let eventEmitter: any;
  let metrics: any;
  let requestContext: any;

  const walletId = 'wallet-uuid-1';

  beforeEach(async () => {
    prisma = {
      walletLimit: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      transaction: {
        findMany: jest.fn(),
      },
      payment: {
        findMany: jest.fn(),
      },
    };
    prisma.$transaction = jest.fn((cb) => cb(prisma));
    eventEmitter = { emit: jest.fn() };
    metrics = {
      incrementLimitExceeded: jest.fn(),
      incrementLimitChecks: jest.fn(),
    };
    requestContext = { getRequestId: jest.fn().mockReturnValue('req-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LimitsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: MetricsService, useValue: metrics },
        { provide: RequestContextService, useValue: requestContext },
      ],
    }).compile();

    service = module.get<LimitsService>(LimitsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('setLimits', () => {
    it('should upsert wallet limits', async () => {
      await service.setLimits(walletId, 100, 10);
      expect(prisma.walletLimit.upsert).toHaveBeenCalledWith({
        where: { walletId },
        update: { dailyLimit: 100, perTransactionLimit: 10, deletedAt: null },
        create: { walletId, dailyLimit: 100, perTransactionLimit: 10 },
      });
    });

    it('should run the existence check and upsert inside a single Prisma transaction', async () => {
      await service.setLimits(walletId, 100, 10);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.walletLimit.findUnique).toHaveBeenCalledWith({
        where: { walletId },
      });
    });

    it('should propagate failure and emit no events if the transaction fails', async () => {
      prisma.$transaction.mockRejectedValue(new Error('deadlock'));
      await expect(service.setLimits(walletId, 100, 10)).rejects.toThrow(
        'deadlock',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    }, 10000);
  });

  describe('getLimits', () => {
    it('should return limits for a wallet', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(limit);
      prisma.transaction.findMany.mockResolvedValue([]);
      const result = await service.getLimits(walletId);
      expect(result).toEqual({ ...limit, remainingDailyLimit: 100 });
    });

    it('should return null when no limits exist for a wallet', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      const result = await service.getLimits(walletId);
      expect(result).toBeNull();
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
      prisma.transaction.findMany.mockResolvedValue([]);
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

    it('should pass when the cumulative daily total lands exactly on the limit', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '40' }]);
      await expect(service.checkLimits(walletId, 60)).resolves.not.toThrow();
    });

    it('should throw as soon as the cumulative daily total exceeds the limit by any amount', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '40' }]);
      await expect(
        service.checkLimits(walletId, 60.01),
      ).rejects.toBeInstanceOf(LimitExceededException);
    });

    it('should sum multiple transactions from today toward the daily total', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([
        { amount: '30' },
        { amount: '20' },
      ]);
      await expect(service.checkLimits(walletId, 51)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });

    it('should not enforce a daily cap when dailyLimit is 0 (unset/unlimited)', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 1000,
        dailyLimit: 0,
      });
      await expect(
        service.checkLimits(walletId, 999),
      ).resolves.not.toThrow();
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    });

    it('should include payment records in the daily usage total', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '50' }]);
      prisma.payment.findMany.mockResolvedValue([{ amount: '30' }]);

      await expect(service.checkLimits(walletId, 21)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });
  });

  describe('removeLimits', () => {
    it('should soft-delete limits for a wallet', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(limit);
      prisma.transaction.findMany.mockResolvedValue([]);
      prisma.walletLimit.update.mockResolvedValue({
        ...limit,
        deletedAt: new Date(),
      });
      await service.removeLimits(walletId);
      expect(prisma.walletLimit.update).toHaveBeenCalledWith({
        where: { walletId },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('should throw NotFoundException if no limits exist', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.removeLimits(walletId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('domain events', () => {
    describe('limit.exceeded', () => {
      it('should emit limit.exceeded when per-transaction limit is exceeded', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          perTransactionLimit: 50,
          dailyLimit: 1000,
        });
        prisma.transaction.findMany.mockResolvedValue([]);

        try {
          await service.checkLimits(walletId, 100);
        } catch (e) {
          // Expected to throw
        }

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.exceeded',
          expect.any(LimitExceededEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.userId).toBe(walletId);
        expect(emittedEvent.limitType).toBe('perTransaction');
        expect(emittedEvent.limit).toBe(50);
        expect(emittedEvent.attempted).toBe(100);
      });

      it('should emit limit.exceeded when daily limit is exceeded', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          perTransactionLimit: 200,
          dailyLimit: 100,
        });
        prisma.transaction.findMany.mockResolvedValue([{ amount: '50' }]);

        try {
          await service.checkLimits(walletId, 60);
        } catch (e) {
          // Expected to throw
        }

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.exceeded',
          expect.any(LimitExceededEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.userId).toBe(walletId);
        expect(emittedEvent.limitType).toBe('daily');
        expect(emittedEvent.limit).toBe(100);
        expect(emittedEvent.attempted).toBe(110);
      });
    });

    describe('limit.updated', () => {
      it('should emit limit.updated events when creating new limits', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue(null);
        prisma.walletLimit.upsert.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 10,
        });

        await service.setLimits(walletId, 100, 10);

        expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.updated',
          expect.any(LimitUpdatedEvent),
        );
      });

      it('should emit limit.updated when modifying daily limit', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 10,
        });
        prisma.walletLimit.upsert.mockResolvedValue({
          walletId,
          dailyLimit: 200,
          perTransactionLimit: 10,
        });

        await service.setLimits(walletId, 200, 10);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.updated',
          expect.any(LimitUpdatedEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.limitType).toBe('daily');
        expect(emittedEvent.oldValue).toBe(100);
        expect(emittedEvent.newValue).toBe(200);
      });

      it('should emit limit.updated when modifying per-transaction limit', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 10,
        });
        prisma.walletLimit.upsert.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 20,
        });

        await service.setLimits(walletId, 100, 20);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.updated',
          expect.any(LimitUpdatedEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.limitType).toBe('perTransaction');
        expect(emittedEvent.oldValue).toBe(10);
        expect(emittedEvent.newValue).toBe(20);
      });
    });
  });
});
