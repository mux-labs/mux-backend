import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTransactionDto, AssetType, TransactionStatus } from './domain/transaction.model';

describe('Idempotency Key Unique Constraint', () => {
  let service: TransactionsService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TransactionsService, PrismaService],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('Idempotency key uniqueness enforcement', () => {
    it('should allow creating transactions with same idempotencyKey (idempotency check)', async () => {
      // First request with idempotencyKey
      const dto1: CreateTransactionDto = {
        amount: '100',
        asset: { type: AssetType.NATIVE },
        senderWalletId: 'wallet-1',
        idempotencyKey: 'test-idem-key-1',
      };

      const tx1 = await service.create(dto1);

      // Second request with same idempotencyKey should return existing transaction
      const dto2: CreateTransactionDto = {
        amount: '200', // Different amount
        asset: { type: AssetType.NATIVE },
        senderWalletId: 'wallet-1',
        idempotencyKey: 'test-idem-key-1',
      };

      const tx2 = await service.create(dto2);

      // Both should return the same transaction (idempotency)
      expect(tx1.id).toBe(tx2.id);
      expect(tx1.amount).toBe(tx2.amount);
    });

    it('should allow creating transactions without idempotencyKey', async () => {
      const dto: CreateTransactionDto = {
        amount: '100',
        asset: { type: AssetType.NATIVE },
        senderWalletId: 'wallet-2',
        // no idempotencyKey
      };

      const tx = await service.create(dto);
      expect(tx).toBeDefined();
      expect(tx.id).toBeDefined();
    });

    it('should enforce database unique constraint on idempotencyKey', async () => {
      // This test verifies that the database constraint prevents direct inserts
      const key = 'test-direct-insert-key';

      const tx1 = await prisma.transaction.create({
        data: {
          amount: '100',
          assetType: AssetType.NATIVE,
          senderWalletId: 'wallet-3',
          idempotencyKey: key,
        },
      });

      expect(tx1.idempotencyKey).toBe(key);

      // Attempting to create another with same key should fail at DB level
      await expect(
        prisma.transaction.create({
          data: {
            amount: '200',
            assetType: AssetType.NATIVE,
            senderWalletId: 'wallet-3',
            idempotencyKey: key,
          },
        }),
      ).rejects.toThrow();
    });

    it('should handle null idempotencyKey (allows multiple null values)', async () => {
      // Database allows multiple NULL values for nullable unique columns
      const dto1: CreateTransactionDto = {
        amount: '100',
        asset: { type: AssetType.NATIVE },
        senderWalletId: 'wallet-4',
        // no idempotencyKey (NULL)
      };

      const dto2: CreateTransactionDto = {
        amount: '200',
        asset: { type: AssetType.NATIVE },
        senderWalletId: 'wallet-4',
        // no idempotencyKey (NULL)
      };

      const tx1 = await service.create(dto1);
      const tx2 = await service.create(dto2);

      // Both should be created (different transactions)
      expect(tx1.id).not.toBe(tx2.id);
      expect(tx1.idempotencyKey).toBeNull();
      expect(tx2.idempotencyKey).toBeNull();
    });
  });

  describe('IdempotencyRecord unique constraint', () => {
    it('should enforce unique constraint on IdempotencyRecord.key', async () => {
      const key = 'test-idempotency-record-key';

      const record1 = await prisma.idempotencyRecord.create({
        data: {
          key,
          method: 'POST',
          endpoint: '/transactions/create',
          response: { success: true },
          expiresAt: new Date(Date.now() + 3600000),
        },
      });

      expect(record1.key).toBe(key);

      // Attempting to create another with same key should fail
      await expect(
        prisma.idempotencyRecord.create({
          data: {
            key,
            method: 'POST',
            endpoint: '/transactions/create',
            response: { success: true },
            expiresAt: new Date(Date.now() + 3600000),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('Payment idempotency constraint', () => {
    it('should enforce unique constraint on Payment.idempotencyKey', async () => {
      const key = 'test-payment-idem-key';

      // Assuming Payment model uses legacy approach
      const payment1 = await prisma.payment.create({
        data: {
          amount: 100,
          currency: 'USD',
          fromId: 1,
          toId: 2,
          userId: 1,
          idempotencyKey: key,
        },
      });

      expect(payment1.idempotencyKey).toBe(key);

      // Attempting to create another with same key should fail
      await expect(
        prisma.payment.create({
          data: {
            amount: 100,
            currency: 'USD',
            fromId: 1,
            toId: 2,
            userId: 1,
            idempotencyKey: key,
          },
        }),
      ).rejects.toThrow();
    });
  });
});
