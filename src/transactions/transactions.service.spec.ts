import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';

const mockWallet = { id: 'wallet-1' };
const mockTransaction = {
  id: 'tx-1',
  amount: '100',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'wallet-1',
  receiverWalletId: null,
  status: TransactionStatus.PENDING,
  stellarHash: null,
  stellarLedger: null,
  stellarFee: null,
  statusChangedAt: new Date(),
  statusReason: null,
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
  metadata: null,
  idempotencyKey: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      wallet: { findUnique: jest.fn() },
      transaction: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
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

  describe('create', () => {
    const baseDto = {
      amount: '100',
      asset: { type: 'NATIVE' },
      senderWalletId: 'wallet-1',
    };

    it('creates a transaction without idempotency key', async () => {
      prisma.wallet.findUnique.mockResolvedValue(mockWallet);
      prisma.transaction.create.mockResolvedValue(mockTransaction);

      const result = await service.create(baseDto);

      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: '100',
          assetType: 'NATIVE',
          status: TransactionStatus.PENDING,
          idempotencyKey: null,
        }),
      });
      expect(result.id).toBe('tx-1');
    });

    it('returns existing transaction on idempotency key hit', async () => {
      const existingTx = { ...mockTransaction, idempotencyKey: 'key-abc' };
      prisma.transaction.findUnique.mockResolvedValue(existingTx);

      const result = await service.create({
        ...baseDto,
        idempotencyKey: 'key-abc',
      });

      // Should not validate wallets or create a new transaction
      expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(result.id).toBe('tx-1');
      expect(result.idempotencyKey).toBe('key-abc');
    });

    it('creates a new transaction when idempotency key is not yet used', async () => {
      const newTx = { ...mockTransaction, idempotencyKey: 'key-new' };
      prisma.transaction.findUnique.mockResolvedValue(null); // no existing tx
      prisma.wallet.findUnique.mockResolvedValue(mockWallet);
      prisma.transaction.create.mockResolvedValue(newTx);

      const result = await service.create({
        ...baseDto,
        idempotencyKey: 'key-new',
      });

      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ idempotencyKey: 'key-new' }),
      });
      expect(result.idempotencyKey).toBe('key-new');
    });

    it('resolves race condition (P2002) by returning the winning transaction', async () => {
      const raceTx = { ...mockTransaction, idempotencyKey: 'key-race' };
      prisma.transaction.findUnique
        .mockResolvedValueOnce(null) // initial check: no existing tx
        .mockResolvedValueOnce(raceTx); // post-P2002 lookup
      prisma.wallet.findUnique.mockResolvedValue(mockWallet);
      prisma.transaction.create.mockRejectedValue({
        code: 'P2002',
        meta: { target: ['idempotencyKey'] },
      });

      const result = await service.create({
        ...baseDto,
        idempotencyKey: 'key-race',
      });

      expect(result.id).toBe('tx-1');
      expect(result.idempotencyKey).toBe('key-race');
    });

    it('re-throws non-idempotency P2002 errors', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.wallet.findUnique.mockResolvedValue(mockWallet);
      const dbError = { code: 'P2002', meta: { target: ['stellarHash'] } };
      prisma.transaction.create.mockRejectedValue(dbError);

      await expect(
        service.create({ ...baseDto, idempotencyKey: 'key-x' }),
      ).rejects.toEqual(dbError);
    });

    it('throws NotFoundException when sender wallet does not exist', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.create(baseDto)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when receiver wallet does not exist', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      prisma.wallet.findUnique
        .mockResolvedValueOnce(mockWallet) // sender found
        .mockResolvedValueOnce(null); // receiver not found

      await expect(
        service.create({ ...baseDto, receiverWalletId: 'wallet-missing' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('throws BadRequestException for invalid status transition', async () => {
      prisma.transaction.findUnique.mockResolvedValue({
        ...mockTransaction,
        status: TransactionStatus.CONFIRMED,
      });

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });

    it('updates status from PENDING to SUBMITTED', async () => {
      const updated = {
        ...mockTransaction,
        status: TransactionStatus.SUBMITTED,
        submittedAt: new Date(),
      };
      prisma.transaction.findUnique.mockResolvedValue(mockTransaction);
      prisma.transaction.update.mockResolvedValue(updated);

      const result = await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
      });

      expect(result.status).toBe(TransactionStatus.SUBMITTED);
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when transaction does not exist', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns the transaction when found', async () => {
      prisma.transaction.findUnique.mockResolvedValue(mockTransaction);
      const result = await service.findOne('tx-1');
      expect(result.id).toBe('tx-1');
    });
  });
});
