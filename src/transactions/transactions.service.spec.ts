import { Test, TestingModule } from '@nestjs/testing';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, ConflictException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';

describe('TransactionsService.create', () => {
  let service: TransactionsService;
  let prisma: {
    transaction: {
      findFirst: jest.Mock;
      create: jest.Mock;
      aggregate: jest.Mock;
    };
  };

  const senderWalletId = 'wallet-sender';
  const otherWalletId = 'wallet-other';

  const baseDto = {
    senderWalletId,
    recipientWalletId: 'wallet-recipient',
    amount: 100,
    asset: 'XLM',
  };

  beforeEach(async () => {
    prisma = {
      transaction: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: 'tx-1', ...data }),
        ),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('assertValidAmount', () => {
    const assertValidAmount = (amount: string) =>
      (service as unknown as { assertValidAmount: (a: string) => void }).assertValidAmount(
        amount,
      );

    it.each(['1e7', '1.', ''])('rejects invalid amount %p', (amount) => {
      expect(() => assertValidAmount(amount)).toThrow(
        expect.objectContaining({ code: 'TRANSACTION_AMOUNT_INVALID' }),
      );
    });

    it('accepts a valid decimal amount', () => {
      expect(() => assertValidAmount('1.0000001')).not.toThrow();
    });
  });
});
