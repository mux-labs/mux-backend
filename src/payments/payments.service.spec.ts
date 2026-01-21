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
      prisma.payment.create.mockResolvedValue({ id: 1, userId: 1, amount: 100, currency: 'USD' });

      const dto = { userId: 1, amount: 100, currency: 'USD' };
      const result = await service.create(dto as any);

      expect(limitsService.checkLimits).toHaveBeenCalledWith(1, 100);
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: { userId: 1, amount: 100, currency: 'USD' },
      });
      expect(result).toEqual({ id: 1, userId: 1, amount: 100, currency: 'USD' });
    });

    it('should throw if limits check fails', async () => {
      limitsService.checkLimits.mockRejectedValue(new Error('Limit exceeded'));

      const dto = { userId: 1, amount: 100, currency: 'USD' };
      await expect(service.create(dto as any)).rejects.toThrow('Limit exceeded');
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });
});
