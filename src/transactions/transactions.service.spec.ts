import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionStatus } from './domain/transaction.model';

const mockDate = new Date('2024-01-01T00:00:00.000Z');

const makePrismaTransaction = (overrides: Partial<any> = {}) => ({
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
  statusChangedAt: mockDate,
  statusReason: null,
  submittedAt: null,
  confirmedAt: null,
  failedAt: null,
  metadata: null,
  createdAt: mockDate,
  updatedAt: mockDate,
  ...overrides,
});

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      wallet: { findUnique: jest.fn() },
      transaction: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
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

    it('should create a transaction when both wallets exist', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-sender' });
      const created = makePrismaTransaction();
      prisma.transaction.create.mockResolvedValue(created);

      const result = await service.create(dto as any);

      expect(prisma.wallet.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.transaction.create).toHaveBeenCalledWith({
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

    it('should throw NotFoundException when sender wallet does not exist', async () => {
      prisma.wallet.findUnique.mockResolvedValueOnce(null);

      await expect(service.create(dto as any)).rejects.toThrow(NotFoundException);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException when receiver wallet does not exist', async () => {
      prisma.wallet.findUnique
        .mockResolvedValueOnce({ id: 'wallet-sender' })
        .mockResolvedValueOnce(null);

      await expect(service.create(dto as any)).rejects.toThrow(NotFoundException);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('should create without receiverWalletId', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-sender' });
      const created = makePrismaTransaction({ receiverWalletId: null });
      prisma.transaction.create.mockResolvedValue(created);

      const result = await service.create({ ...dto, receiverWalletId: undefined } as any);

      expect(prisma.wallet.findUnique).toHaveBeenCalledTimes(1);
      expect(result.receiverWalletId).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all transactions without filters', async () => {
      const txs = [makePrismaTransaction()];
      prisma.transaction.findMany.mockResolvedValue(txs);

      const result = await service.findAll();

      expect(prisma.transaction.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: { createdAt: 'desc' },
        take: undefined,
        skip: undefined,
      });
      expect(result).toHaveLength(1);
    });

    it('should apply senderWalletId filter', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ senderWalletId: 'wallet-sender' });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { senderWalletId: 'wallet-sender' } }),
      );
    });

    it('should apply pagination', async () => {
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.findAll({ limit: 10, offset: 20 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 20 }),
      );
    });
  });

  describe('findByWallet', () => {
    it('should return transactions for a valid wallet', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      const txs = [makePrismaTransaction()];
      prisma.transaction.findMany.mockResolvedValue(txs);

      const result = await service.findByWallet('wallet-1');

      expect(prisma.wallet.findUnique).toHaveBeenCalledWith({ where: { id: 'wallet-1' } });
      expect(prisma.transaction.findMany).toHaveBeenCalledWith({
        where: {
          OR: [{ senderWalletId: 'wallet-1' }, { receiverWalletId: 'wallet-1' }],
        },
        orderBy: { createdAt: 'desc' },
        take: undefined,
        skip: undefined,
      });
      expect(result).toHaveLength(1);
    });

    it('should throw NotFoundException when wallet does not exist', async () => {
      prisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.findByWallet('nonexistent')).rejects.toThrow(
        new NotFoundException('Wallet nonexistent not found'),
      );
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    });

    it('should apply pagination', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      prisma.transaction.findMany.mockResolvedValue([]);

      await service.findByWallet('wallet-1', { limit: 5, offset: 10 });

      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 10 }),
      );
    });

    it('should return empty array when wallet has no transactions', async () => {
      prisma.wallet.findUnique.mockResolvedValue({ id: 'wallet-1' });
      prisma.transaction.findMany.mockResolvedValue([]);

      const result = await service.findByWallet('wallet-1');

      expect(result).toEqual([]);
    });
  });

  describe('updateStatus', () => {
    it('should update status with valid transition', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.PENDING });
      const updated = makePrismaTransaction({ status: TransactionStatus.SUBMITTED });
      prisma.transaction.findUnique.mockResolvedValue(existing);
      prisma.transaction.update.mockResolvedValue(updated);

      const result = await service.updateStatus('tx-1', {
        status: TransactionStatus.SUBMITTED,
      });

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tx-1' },
          data: expect.objectContaining({
            status: TransactionStatus.SUBMITTED,
            submittedAt: expect.any(Date),
          }),
        }),
      );
      expect(result.status).toBe(TransactionStatus.SUBMITTED);
    });

    it('should throw NotFoundException when transaction does not exist', async () => {
      prisma.transaction.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('nonexistent', { status: TransactionStatus.SUBMITTED }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid status transition', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.CONFIRMED });
      prisma.transaction.findUnique.mockResolvedValue(existing);

      await expect(
        service.updateStatus('tx-1', { status: TransactionStatus.PENDING }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should set confirmedAt when transitioning to CONFIRMED', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.SUBMITTED });
      const updated = makePrismaTransaction({ status: TransactionStatus.CONFIRMED });
      prisma.transaction.findUnique.mockResolvedValue(existing);
      prisma.transaction.update.mockResolvedValue(updated);

      await service.updateStatus('tx-1', { status: TransactionStatus.CONFIRMED });

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ confirmedAt: expect.any(Date) }),
        }),
      );
    });

    it('should set failedAt when transitioning to FAILED', async () => {
      const existing = makePrismaTransaction({ status: TransactionStatus.PENDING });
      const updated = makePrismaTransaction({ status: TransactionStatus.FAILED });
      prisma.transaction.findUnique.mockResolvedValue(existing);
      prisma.transaction.update.mockResolvedValue(updated);

      await service.updateStatus('tx-1', { status: TransactionStatus.FAILED });

      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failedAt: expect.any(Date) }),
        }),
      );
    });
  });
});
