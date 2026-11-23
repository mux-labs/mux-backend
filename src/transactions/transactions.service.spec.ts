import { BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { LimitsService } from '../limits/limits.service';

describe('TransactionsService.assertValidAmount (issue #1330)', () => {
  let service: TransactionsService;
  let prisma: Record<string, jest.Mock>;
  let balanceIndexer: { getBalance: jest.Mock };
  let webhookEventEmitter: { emitTransactionCreated: jest.Mock };
  let limitsService: { checkLimits: jest.Mock };

  beforeEach(() => {
    prisma = {
      transaction: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      wallet: {
        findUnique: jest.fn(),
      },
    };
    balanceIndexer = { getBalance: jest.fn() };
    webhookEventEmitter = { emitTransactionCreated: jest.fn() };
    limitsService = { checkLimits: jest.fn() };

    service = new TransactionsService(
      prisma as unknown as PrismaService,
      balanceIndexer as unknown as BalanceIndexerService,
      webhookEventEmitter as unknown as WebhookEventEmitterService,
      limitsService as unknown as LimitsService,
    );
  });

  const assertValidAmount = (amount: string) =>
    (service as any).assertValidAmount(amount);

  it('rejects amounts that are not a finite, strictly positive decimal string with at most 7 decimal places', () => {
    const invalidAmounts = [
      '',
      'abc',
      '-1',
      '0',
      '0.0000000',
      '1.00000001',
      '1.',
      '.1',
      '1e3',
      'Infinity',
      'NaN',
      '1.2.3',
    ];

    for (const amount of invalidAmounts) {
      expect(() => assertValidAmount(amount)).toThrow(BadRequestException);
    }
  });

  it('accepts a finite, strictly positive decimal string with at most 7 decimal places', () => {
    for (const amount of ['1', '0.1', '1.0000000', '123456789.1234567']) {
      expect(() => assertValidAmount(amount)).not.toThrow();
    }
  });

  it('runs before any balance or limit work so malformed values never reach those checks or the database', async () => {
    await expect(
      service.create(
        {
          amount: 'not-a-number',
          asset: { type: 'NATIVE' },
          senderWalletId: 'sender-wallet',
        } as any,
        'developer-id',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.transaction.findUnique).not.toHaveBeenCalled();
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(balanceIndexer.getBalance).not.toHaveBeenCalled();
    expect(limitsService.checkLimits).not.toHaveBeenCalled();
  });
});
