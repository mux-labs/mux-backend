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
    it('rejects a zero amount', () => {
      expect(() => service.assertValidAmount(0)).toThrow();
    });

    it('rejects 0.0000000', () => {
      expect(() => service.assertValidAmount(0.0000000)).toThrow();
    });

    it('accepts the smallest 7-decimal amount 0.0000001', () => {
      expect(() => service.assertValidAmount(0.0000001)).not.toThrow();
    });
  });
});
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('assertValidAmount', () => {
    it('rejects a zero amount', () => {
      expect(() => service.assertValidAmount(0)).toThrow();
    });

    it('rejects 0.0000000', () => {
      expect(() => service.assertValidAmount(0.0000000)).toThrow();
    });

    it('accepts the smallest 7-decimal amount 0.0000001', () => {
      expect(() => service.assertValidAmount(0.0000001)).not.toThrow();
    });
  });

  it('creates a new transaction in PENDING state', async () => {
    const result = await service.create(baseDto as any);

    expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ status: 'PENDING' }));
  });

  it('enforces per-transaction limit fail-closed with 403', async () => {
    await expect(
      service.create({ ...baseDto, amount: 1_000_000_000 } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('enforces daily spending limit fail-closed with 403', async () => {
    prisma.transaction.aggregate.mockResolvedValue({
      _sum: { amount: 1_000_000_000 },
    });

    await expect(service.create(baseDto as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('returns existing transaction for same-wallet idempotency key without side-effects', async () => {
    const existing = {
      id: 'tx-existing',
      senderWalletId,
      idempotencyKey: 'idem-1',
      status: 'PENDING',
    };
    prisma.transaction.findFirst.mockResolvedValue(existing);

    const result = await service.create({
      ...baseDto,
      idempotencyKey: 'idem-1',
    } as any);

    expect(result).toEqual(existing);
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('rejects idempotency key used by a different sender wallet with 409', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'tx-existing',
      senderWalletId: otherWalletId,
      idempotencyKey: 'idem-1',
      status: 'PENDING',
    });

    await expect(
      service.create({ ...baseDto, idempotencyKey: 'idem-1' } as any),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });
  });
});
