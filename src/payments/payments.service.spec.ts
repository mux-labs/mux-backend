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
        updatedAt: paymentDate
      });

      const dto = { fromId: 1, toId: 2, amount: 100, currency: 'USD', description: 'Test payment' };
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
          status: 'PENDING'
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
        updatedAt: paymentDate
      });
    });

    it('should throw if limits check fails', async () => {
      limitsService.checkLimits.mockRejectedValue(new Error('Limit exceeded'));

      const dto = { fromId: 1, toId: 2, amount: 100, currency: 'USD' };
      await expect(service.create(dto as any)).rejects.toThrow('Limit exceeded');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });
});
