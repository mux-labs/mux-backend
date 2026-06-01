import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';

const mockPrisma = {
  wallet: {
    findUnique: jest.fn(),
  },
  transaction: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const baseTransaction = {
  id: 'tx-1',
  amount: '100',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'wallet-sender',
  receiverWalletId: 'wallet-receiver',
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
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('TransactionsService', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const dto = {
      amount: '100',
      asset: { type: 'NATIVE' },
      senderWalletId: 'wallet-sender',
      receiverWalletId: 'wallet-receiver',
    };

    it('creates a transaction when both wallets exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-sender' });
      mockPrisma.transaction.create.mockResolvedValue(baseTransaction);

      const result = await service.create(dto);

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          amount: '100',
          assetType: 'NATIVE',
          senderWalletId: 'wallet-sender',
          receiverWalletId: 'wallet-receiver',
          status: TransactionStatus.PENDING,
        }),
      });
      expect(result.id).toBe('tx-1');
    });

    it('throws NotFoundException when sender wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValueOnce(null);

      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when receiver wallet not found', async () => {
      mockPrisma.wallet.findUnique
        .mockResolvedValueOnce({ id: 'wallet-sender' })
        .mockResolvedValueOnce(null);

      await expect(service.create(dto)).rejects.toThrow(NotFoundException);
    });

    it('creates without receiverWalletId', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-sender' });
      mockPrisma.transaction.create.mockResolvedValue({
        ...baseTransaction,
        receiverWalletId: null,
      });

      const result = await service.create({ ...dto, receiverWalletId: undefined });

      expect(mockPrisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ receiverWalletId: null }),
      });
      expect(result.receiverWalletId).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns all transactions without filters', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([baseTransaction]);

      const result = await service.findAll();

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: undefined,
        skip: undefined,
      });
      expect(result).toHaveLength(1);
    });

    it('applies senderWalletId filter', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([baseTransaction]);

      await service.findAll({ senderWalletId: 'wallet-sender' });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { senderWalletId: 'wallet-sender' } }),
      );
    });

    it('applies status filter', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ status: TransactionStatus.CONFIRMED });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: TransactionStatus.CONFIRMED } }),
      );
    });

    it('applies limit and offset', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ limit: 10, offset: 5 });

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 5 }),
      );
    });
  });

  describe('findOne', () => {
    it('returns transaction when found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(baseTransaction);

      const result = await service.findOne('tx-1');

      expect(result.id).toBe('tx-1');
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('updates status with valid transition', async () => {
      const updated = { ...baseTransaction, status: TransactionStatus.SUBMITTED, submittedAt: new Date() };
      mockPrisma.transaction.findUnique.mockResolvedValue(baseTransaction);
      mockPrisma.transaction.update.mockResolvedValue(updated);

      const result = await service.updateStatus('tx-1', { status: TransactionStatus.SUBMITTED });

      expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: expect.objectContaining({
          status: TransactionStatus.SUBMITTED,
          submittedAt: expect.any(Date),
        }),
      });
      expect(result.status).toBe(TransactionStatus.SUBMITTED);
    });

    it('throws NotFoundException when transaction not found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing', { status: TransactionStatus.SUBMITTED }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid transition', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue({
        ...baseTransaction,
        status: TransactionStatus.CONFIRMED,
      });

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });

    it('sets confirmedAt when transitioning to CONFIRMED', async () => {
      const submitted = { ...baseTransaction, status: TransactionStatus.SUBMITTED };
      const confirmed = { ...submitted, status: TransactionStatus.CONFIRMED, confirmedAt: new Date() };
      mockPrisma.transaction.findUnique.mockResolvedValue(submitted);
      mockPrisma.transaction.update.mockResolvedValue(confirmed);

      await service.updateStatus('tx-1', { status: TransactionStatus.CONFIRMED });

      expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: expect.objectContaining({ confirmedAt: expect.any(Date) }),
      });
    });

    it('sets failedAt when transitioning to FAILED', async () => {
      const failed = { ...baseTransaction, status: TransactionStatus.FAILED, failedAt: new Date() };
      mockPrisma.transaction.findUnique.mockResolvedValue(baseTransaction);
      mockPrisma.transaction.update.mockResolvedValue(failed);

      await service.updateStatus('tx-1', { status: TransactionStatus.FAILED, statusReason: 'timeout' });

      expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: expect.objectContaining({
          failedAt: expect.any(Date),
          statusReason: 'timeout',
        }),
      });
    });

    it('updates stellarHash when provided', async () => {
      const updated = { ...baseTransaction, status: TransactionStatus.SUBMITTED, stellarHash: 'abc123' };
      mockPrisma.transaction.findUnique.mockResolvedValue(baseTransaction);
      mockPrisma.transaction.update.mockResolvedValue(updated);

      await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
        stellarHash: 'abc123',
      });

      expect(mockPrisma.transaction.update).toHaveBeenCalledWith({
        where: { id: 'tx-1' },
        data: expect.objectContaining({ stellarHash: 'abc123' }),
      });
    });
  });

  describe('findByStellarHash', () => {
    it('returns transaction when found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue({ ...baseTransaction, stellarHash: 'hash-abc' });

      const result = await service.findByStellarHash('hash-abc');

      expect(result?.stellarHash).toBe('hash-abc');
    });

    it('returns null when not found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      const result = await service.findByStellarHash('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByWallet', () => {
    it('returns transactions for wallet as sender or receiver', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([baseTransaction]);

      const result = await service.findByWallet('wallet-sender');

      expect(mockPrisma.transaction.findMany).toHaveBeenCalledWith({
        where: {
          OR: [
            { senderWalletId: 'wallet-sender' },
            { receiverWalletId: 'wallet-sender' },
          ],
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });

    it('returns empty array when wallet has no transactions', async () => {
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      const result = await service.findByWallet('wallet-empty');

      expect(result).toEqual([]);
    });
  });
});
