import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';

describe('LimitsService webhook events', () => {
  let service: LimitsService;
  let prisma: jest.Mocked<PrismaService>;
  let webhookEmitter: jest.Mocked<WebhookEventEmitterService>;

  beforeEach(() => {
    prisma = {
      walletLimit: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      transaction: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;

    webhookEmitter = {
      emitLimitUpdated: jest.fn().mockResolvedValue(undefined),
      emitLimitExceeded: jest.fn().mockResolvedValue(undefined),
      emitLimitWarning: jest.fn().mockResolvedValue(undefined),
    } as any;

    service = new LimitsService(prisma, webhookEmitter);
  });

  describe('setLimits', () => {
    it('emits limit.updated webhook when creating new limits', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      prisma.walletLimit.upsert.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 1000,
        perTransactionLimit: 100,
      } as any);

      await service.setLimits('w1', 1000, 100);

      expect(webhookEmitter.emitLimitUpdated).toHaveBeenCalledWith({
        walletId: 'w1',
        limitType: 'daily',
        oldValue: null,
        newValue: 1000,
      });
      expect(webhookEmitter.emitLimitUpdated).toHaveBeenCalledWith({
        walletId: 'w1',
        limitType: 'perTransaction',
        oldValue: null,
        newValue: 100,
      });
    });

    it('emits limit.updated only for changed values', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 1000,
        perTransactionLimit: 100,
      } as any);
      prisma.walletLimit.upsert.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 2000,
        perTransactionLimit: 100,
      } as any);

      await service.setLimits('w1', 2000, 100);

      expect(webhookEmitter.emitLimitUpdated).toHaveBeenCalledTimes(1);
      expect(webhookEmitter.emitLimitUpdated).toHaveBeenCalledWith({
        walletId: 'w1',
        limitType: 'daily',
        oldValue: 1000,
        newValue: 2000,
      });
    });
  });

  describe('checkLimits', () => {
    it('emits limit.exceeded when per-tx limit is exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 10000,
        perTransactionLimit: 50,
      } as any);

      await expect(service.checkLimits('w1', 100)).rejects.toThrow(
        'Transaction limit exceeded',
      );

      expect(webhookEmitter.emitLimitExceeded).toHaveBeenCalledWith({
        walletId: 'w1',
        limitType: 'perTransaction',
        limit: 50,
        attempted: 100,
      });
    });

    it('emits limit.exceeded when daily limit is exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 100,
        perTransactionLimit: 200,
      } as any);
      prisma.transaction.findMany.mockResolvedValue([
        { amount: '90' },
      ] as any);

      await expect(service.checkLimits('w1', 20)).rejects.toThrow(
        'Daily limit exceeded',
      );

      expect(webhookEmitter.emitLimitExceeded).toHaveBeenCalledWith({
        walletId: 'w1',
        limitType: 'daily',
        limit: 100,
        attempted: 110,
      });
    });

    it('emits limit.warning when approaching 80% of daily limit', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 100,
        perTransactionLimit: 200,
      } as any);
      prisma.transaction.findMany.mockResolvedValue([
        { amount: '70' },
      ] as any);

      await service.checkLimits('w1', 15);

      expect(webhookEmitter.emitLimitWarning).toHaveBeenCalledWith({
        walletId: 'w1',
        limitType: 'daily',
        limit: 100,
        projected: 85,
      });
    });

    it('does not throw when webhook dispatch fails', async () => {
      webhookEmitter.emitLimitExceeded.mockRejectedValue(new Error('dispatch fail'));
      prisma.walletLimit.findUnique.mockResolvedValue({
        walletId: 'w1',
        dailyLimit: 10000,
        perTransactionLimit: 50,
      } as any);

      // The limits check itself should still throw, but webhook failure is swallowed
      await expect(service.checkLimits('w1', 100)).rejects.toThrow(
        'Transaction limit exceeded',
      );
    });
  });
});
