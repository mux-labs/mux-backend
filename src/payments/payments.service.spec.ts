import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: any;
  let limitsService: any;

  const fromWalletId = 'wallet-uuid-sender';
  const toWalletId = 'wallet-uuid-receiver';

  beforeEach(async () => {
    prisma = {
      transaction: {
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
    it('should create a transaction if limits check passes', async () => {
      limitsService.checkLimits.mockResolvedValue(undefined);
      const now = new Date();
      const txRecord = {
        id: 'tx-uuid-1',
        senderWalletId: fromWalletId,
        receiverWalletId: toWalletId,
        amount: '100',
        assetType: 'USD',
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
      };
      prisma.transaction.create.mockResolvedValue(txRecord);

      const dto = {
        fromWalletId,
        toWalletId,
        amount: 100,
        currency: 'USD',
        description: 'Test payment',
      };
      const result = await service.create(dto as any);

      expect(limitsService.checkLimits).toHaveBeenCalledWith(fromWalletId, 100);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: {
          senderWalletId: fromWalletId,
          receiverWalletId: toWalletId,
          amount: '100',
          assetType: 'USD',
          metadata: { description: 'Test payment' },
          status: 'PENDING',
        },
      });
      expect(result).toEqual(txRecord);
    });

    it('should omit metadata when no description provided', async () => {
      limitsService.checkLimits.mockResolvedValue(undefined);
      prisma.transaction.create.mockResolvedValue({});

      await service.create({ fromWalletId, toWalletId, amount: 50, currency: 'XLM' } as any);

      const call = prisma.transaction.create.mock.calls[0][0];
      expect(call.data.metadata).toBeUndefined();
    });

    it('should throw if limits check fails', async () => {
      limitsService.checkLimits.mockRejectedValue(new Error('Limit exceeded'));

      await expect(
        service.create({ fromWalletId, toWalletId, amount: 100, currency: 'USD' } as any),
      ).rejects.toThrow('Limit exceeded');
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });
  });
});
