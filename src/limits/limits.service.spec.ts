import { Test, TestingModule } from '@nestjs/testing';
import { LimitsService } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';

describe('LimitsService', () => {
  let service: LimitsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      userLimit: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
      },
      payment: {
        aggregate: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LimitsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<LimitsService>(LimitsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('setLimits', () => {
    it('should upsert limits', async () => {
      await service.setLimits(1, 100, 10);
      expect(prisma.userLimit.upsert).toHaveBeenCalledWith({
        where: { userId: 1 },
        update: { dailyLimit: 100, perTransactionLimit: 10 },
        create: { userId: 1, dailyLimit: 100, perTransactionLimit: 10 },
      });
    });
  });

  describe('checkLimits', () => {
    it('should pass if no limits set', async () => {
      prisma.userLimit.findUnique.mockResolvedValue(null);
      await expect(service.checkLimits(1, 100)).resolves.not.toThrow();
    });

    it('should throw if per transaction limit exceeded', async () => {
      prisma.userLimit.findUnique.mockResolvedValue({ perTransactionLimit: 50, dailyLimit: 1000 });
      await expect(service.checkLimits(1, 100)).rejects.toThrow('Transaction limit exceeded');
    });

    it('should throw if daily limit exceeded', async () => {
      prisma.userLimit.findUnique.mockResolvedValue({ perTransactionLimit: 200, dailyLimit: 100 });
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 50 } });
      await expect(service.checkLimits(1, 60)).rejects.toThrow('Daily limit exceeded');
    });

    it('should pass if within limits', async () => {
      prisma.userLimit.findUnique.mockResolvedValue({ perTransactionLimit: 200, dailyLimit: 100 });
      prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 40 } });
      await expect(service.checkLimits(1, 50)).resolves.not.toThrow();
    });
  });
});
