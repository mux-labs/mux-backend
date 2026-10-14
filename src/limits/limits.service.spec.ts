import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from './limits.service';

// These modules are imported by limits.service.ts but are not present on
// main at the time of writing, so they are stubbed here to unit-test the
// service in isolation. retryWithBackoff runs the operation once.
jest.mock('./dto/create-limit.dto', () => ({}), { virtual: true });
jest.mock('./dto/limits-response.dto', () => ({}), { virtual: true });
jest.mock(
  './events/limit-updated.event',
  () => ({ LimitUpdatedEvent: class {} }),
  { virtual: true },
);
jest.mock(
  './events/limit-exceeded.event',
  () => ({ LimitExceededEvent: class {} }),
  { virtual: true },
);
jest.mock(
  './events/limit-warning.event',
  () => ({ LimitWarningEvent: class {} }),
  { virtual: true },
);
jest.mock(
  '../common/utils/retry',
  () => ({ retryWithBackoff: (fn: () => unknown) => fn() }),
  { virtual: true },
);
jest.mock('../metrics/metrics.service', () => ({ MetricsService: class {} }), {
  virtual: true,
});

describe('LimitsService (#1102)', () => {
  const walletId = 'wallet-1';
  let service: LimitsService;
  let walletLimit: {
    upsert: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  let prisma: { walletLimit: typeof walletLimit; $transaction: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  beforeEach(() => {
    walletLimit = {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    };
    prisma = {
      walletLimit,
      $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
        fn({ walletLimit }),
      ),
    };
    eventEmitter = { emit: jest.fn() };
    service = new LimitsService(
      prisma as unknown as PrismaService,
      eventEmitter as unknown as EventEmitter2,
      {} as never,
      {} as never,
    );
  });

  describe('setLimits', () => {
    it('upserts valid limits in both the update and create branches', async () => {
      walletLimit.findUnique.mockResolvedValue(null);
      walletLimit.upsert.mockResolvedValue({
        walletId,
        dailyLimit: 100,
        perTransactionLimit: 10,
      });

      await service.setLimits(walletId, 100, 10);

      expect(walletLimit.upsert).toHaveBeenCalledWith({
        where: { walletId },
        update: { dailyLimit: 100, perTransactionLimit: 10, deletedAt: null },
        create: { walletId, dailyLimit: 100, perTransactionLimit: 10 },
      });
    });

    it('accepts zero limits', async () => {
      walletLimit.findUnique.mockResolvedValue(null);
      walletLimit.upsert.mockResolvedValue({
        walletId,
        dailyLimit: 0,
        perTransactionLimit: 0,
      });

      await service.setLimits(walletId, 0, 0);
      expect(walletLimit.upsert).toHaveBeenCalledTimes(1);
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
        await expect(
          service.setLimits(walletId, daily, perTx),
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(service.setLimits(walletId, daily, perTx)).rejects.toThrow(
          field,
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(walletLimit.upsert).not.toHaveBeenCalled();
      },
    );
  });

  describe('updateLimits', () => {
    it.each([
      ['negative daily', -5, undefined],
      ['NaN perTx', undefined, NaN],
    ])('rejects %s before reading or writing', async (_label, daily, perTx) => {
      await expect(
        service.updateLimits(walletId, daily, perTx),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(walletLimit.findUnique).not.toHaveBeenCalled();
      expect(walletLimit.update).not.toHaveBeenCalled();
    });
  });

  describe('getLimits', () => {
    it('returns the stored limits', async () => {
      walletLimit.findUnique.mockResolvedValue({
        walletId,
        dailyLimit: 0,
        perTransactionLimit: 10,
      });

      await expect(service.getLimits(walletId)).resolves.toMatchObject({
        walletId,
        dailyLimit: 0,
        perTransactionLimit: 10,
      });
      expect(walletLimit.findUnique).toHaveBeenCalledWith({
        where: { walletId },
      });
    });

    it('returns null for an unknown wallet', async () => {
      walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.getLimits('unknown')).resolves.toBeNull();
    });
  });

  describe('removeLimits', () => {
    it('throws NotFoundException and writes nothing when no row exists', async () => {
      walletLimit.findUnique.mockResolvedValue(null);

      await expect(service.removeLimits(walletId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(walletLimit.update).not.toHaveBeenCalled();
    });

    it('soft-deletes the row when it exists', async () => {
      walletLimit.findUnique.mockResolvedValue({
        walletId,
        dailyLimit: 0,
        perTransactionLimit: 10,
      });
      walletLimit.update.mockResolvedValue({});

      await service.removeLimits(walletId);
      expect(walletLimit.update).toHaveBeenCalledWith({
        where: { walletId },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });
});
