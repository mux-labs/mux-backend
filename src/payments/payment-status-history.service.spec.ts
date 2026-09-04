import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatusHistoryService } from './payment-status-history.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaymentStatusHistoryService', () => {
  let service: PaymentStatusHistoryService;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = {
      paymentStatusHistory: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentStatusHistoryService,
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<PaymentStatusHistoryService>(
      PaymentStatusHistoryService,
    );
  });

  describe('recordStatusChange', () => {
    it('should create a status history record on successful transition', async () => {
      mockPrisma.paymentStatusHistory.create.mockResolvedValue({
        id: 'history-1',
        paymentId: 1,
        fromStatus: 'PENDING',
        toStatus: 'CONFIRMED',
        reason: null,
        changedBy: 'api',
        changedAt: new Date(),
        metadata: null,
      });

      await service.recordStatusChange({
        paymentId: 1,
        fromStatus: 'PENDING',
        toStatus: 'CONFIRMED',
        changedBy: 'api',
        metadata: { requestId: 'req-123' },
      });

      expect(mockPrisma.paymentStatusHistory.create).toHaveBeenCalledWith({
        data: {
          paymentId: 1,
          fromStatus: 'PENDING',
          toStatus: 'CONFIRMED',
          reason: null,
          changedBy: 'api',
          metadata: { requestId: 'req-123' },
        },
      });
    });

    it('should not throw when database write fails (best-effort)', async () => {
      mockPrisma.paymentStatusHistory.create.mockRejectedValue(
        new Error('DB connection lost'),
      );

      await expect(
        service.recordStatusChange({
          paymentId: 1,
          fromStatus: 'PENDING',
          toStatus: 'FAILED',
          reason: 'Insufficient funds',
        }),
      ).resolves.toBeUndefined();
    });

    it('should record status change with null fromStatus (initial creation)', async () => {
      mockPrisma.paymentStatusHistory.create.mockResolvedValue({
        id: 'history-2',
        paymentId: 2,
        fromStatus: null,
        toStatus: 'PENDING',
        reason: 'Payment created',
        changedBy: 'system',
        changedAt: new Date(),
        metadata: null,
      });

      await service.recordStatusChange({
        paymentId: 2,
        fromStatus: null,
        toStatus: 'PENDING',
        reason: 'Payment created',
        changedBy: 'system',
      });

      expect(mockPrisma.paymentStatusHistory.create).toHaveBeenCalledWith({
        data: {
          paymentId: 2,
          fromStatus: null,
          toStatus: 'PENDING',
          reason: 'Payment created',
          changedBy: 'system',
          metadata: undefined,
        },
      });
    });
  });

  describe('getHistory', () => {
    it('should return status history records ordered by changedAt ascending', async () => {
      const mockRecords = [
        {
          id: 'h1',
          paymentId: 1,
          fromStatus: null,
          toStatus: 'PENDING',
          changedAt: new Date('2026-01-01'),
        },
        {
          id: 'h2',
          paymentId: 1,
          fromStatus: 'PENDING',
          toStatus: 'CONFIRMED',
          changedAt: new Date('2026-01-02'),
        },
      ];

      mockPrisma.paymentStatusHistory.findMany.mockResolvedValue(mockRecords);

      const result = await service.getHistory(1);

      expect(result).toHaveLength(2);
      expect(result[0].toStatus).toBe('PENDING');
      expect(result[1].toStatus).toBe('CONFIRMED');
      expect(mockPrisma.paymentStatusHistory.findMany).toHaveBeenCalledWith({
        where: { paymentId: 1 },
        orderBy: { changedAt: 'asc' },
      });
    });

    it('should return empty array when no history exists', async () => {
      mockPrisma.paymentStatusHistory.findMany.mockResolvedValue([]);

      const result = await service.getHistory(999);

      expect(result).toEqual([]);
    });
  });

  describe('getRecentHistory', () => {
    it('should return recent history with default limit of 50', async () => {
      mockPrisma.paymentStatusHistory.findMany.mockResolvedValue([]);

      await service.getRecentHistory();

      expect(mockPrisma.paymentStatusHistory.findMany).toHaveBeenCalledWith({
        orderBy: { changedAt: 'desc' },
        take: 50,
      });
    });

    it('should respect custom limit', async () => {
      mockPrisma.paymentStatusHistory.findMany.mockResolvedValue([]);

      await service.getRecentHistory(10);

      expect(mockPrisma.paymentStatusHistory.findMany).toHaveBeenCalledWith({
        orderBy: { changedAt: 'desc' },
        take: 10,
      });
    });
  });
});
