import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: any;
  let limitsService: any;

  beforeEach(async () => {
    prisma = {
      payment: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
    };
    limitsService = {
      checkLimits: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LimitsService, useValue: limitsService },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create payment if limits check passes', async () => {
      limitsService.checkLimits.mockResolvedValue(undefined);
      const paymentDate = new Date();
      prisma.payment.create.mockResolvedValue({
        id: 1,
        fromId: 1,
        toId: 2,
        amount: 100,
        currency: 'USD',
        description: 'Test payment',
        status: 'PENDING',
        userId: 1,
        createdAt: paymentDate,
        updatedAt: paymentDate,
      });

      const dto = {
        fromId: 1,
        toId: 2,
        amount: 100,
        currency: 'USD',
        description: 'Test payment',
      };
      const result = await service.create(dto as any);

      expect(limitsService.checkLimits).toHaveBeenCalledWith(1, 100);
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          fromId: 1,
          toId: 2,
          amount: 100,
          currency: 'USD',
          description: 'Test payment',
          userId: 1,
          status: 'PENDING',
        },
      });
      expect(result).toEqual({
        id: 1,
        fromId: 1,
        toId: 2,
        amount: 100,
        currency: 'USD',
        description: 'Test payment',
        status: 'PENDING',
        userId: 1,
        createdAt: paymentDate,
        updatedAt: paymentDate,
      });
    });

    it('should throw if limits check fails', async () => {
      limitsService.checkLimits.mockRejectedValue(new Error('Limit exceeded'));

      const dto = { fromId: 1, toId: 2, amount: 100, currency: 'USD' };
      await expect(service.create(dto as any)).rejects.toThrow(
        'Limit exceeded',
      );
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should throw NotFoundException when payment does not exist', async () => {
      prisma.payment.findUnique.mockResolvedValue(null);
      await expect(service.remove(99)).rejects.toThrow('Payment #99 not found');
      expect(prisma.payment.delete).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when payment is not PENDING', async () => {
      prisma.payment.findUnique.mockResolvedValue({ id: 1, status: 'CONFIRMED' });
      await expect(service.remove(1)).rejects.toThrow(
        'Cannot delete payment in status: CONFIRMED',
      );
      expect(prisma.payment.delete).not.toHaveBeenCalled();
    });

    it('should delete and return payment when status is PENDING', async () => {
      const payment = { id: 1, status: 'PENDING', amount: 100 };
      prisma.payment.findUnique.mockResolvedValue(payment);
      prisma.payment.delete.mockResolvedValue(payment);

      const result = await service.remove(1);

      expect(prisma.payment.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(result).toEqual(payment);
    });
  });
});
