import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { TransactionStatus } from './domain/transaction.model';

const mockTransactionsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  updateStatus: jest.fn(),
  findByStellarHash: jest.fn(),
  findByWallet: jest.fn(),
};

const baseTx = {
  id: 'tx-1',
  amount: '100',
  assetType: 'NATIVE',
  status: TransactionStatus.PENDING,
  senderWalletId: 'wallet-sender',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('TransactionsController', () => {
  let controller: TransactionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        { provide: TransactionsService, useValue: mockTransactionsService },
      ],
    })
      .overrideGuard(require('../api-keys/api-key.guard').ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(require('../rate-limit/rate-limit.guard').RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<TransactionsController>(TransactionsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('delegates to service.create', async () => {
      const dto = { amount: '100', asset: { type: 'NATIVE' }, senderWalletId: 'wallet-sender' };
      mockTransactionsService.create.mockResolvedValue(baseTx);

      const result = await controller.create(dto as any);

      expect(mockTransactionsService.create).toHaveBeenCalledWith(dto);
      expect(result).toEqual(baseTx);
    });
  });

  describe('findAll', () => {
    it('delegates to service.findAll with parsed params', async () => {
      mockTransactionsService.findAll.mockResolvedValue([baseTx]);

      const result = await controller.findAll('wallet-sender', undefined, TransactionStatus.PENDING, '10', '0');

      expect(mockTransactionsService.findAll).toHaveBeenCalledWith({
        senderWalletId: 'wallet-sender',
        receiverWalletId: undefined,
        status: TransactionStatus.PENDING,
        limit: 10,
        offset: 0,
      });
      expect(result).toEqual([baseTx]);
    });

    it('passes undefined limit/offset when not provided', async () => {
      mockTransactionsService.findAll.mockResolvedValue([]);

      await controller.findAll();

      expect(mockTransactionsService.findAll).toHaveBeenCalledWith({
        senderWalletId: undefined,
        receiverWalletId: undefined,
        status: undefined,
        limit: undefined,
        offset: undefined,
      });
    });
  });

  describe('findOne', () => {
    it('delegates to service.findOne', async () => {
      mockTransactionsService.findOne.mockResolvedValue(baseTx);

      const result = await controller.findOne('tx-1');

      expect(mockTransactionsService.findOne).toHaveBeenCalledWith('tx-1');
      expect(result).toEqual(baseTx);
    });
  });

  describe('updateStatus', () => {
    it('delegates to service.updateStatus', async () => {
      const dto = { status: TransactionStatus.SUBMITTED };
      const updated = { ...baseTx, status: TransactionStatus.SUBMITTED };
      mockTransactionsService.updateStatus.mockResolvedValue(updated);

      const result = await controller.updateStatus('tx-1', dto as any);

      expect(mockTransactionsService.updateStatus).toHaveBeenCalledWith('tx-1', dto);
      expect(result.status).toBe(TransactionStatus.SUBMITTED);
    });
  });

  describe('findByStellarHash', () => {
    it('delegates to service.findByStellarHash', async () => {
      mockTransactionsService.findByStellarHash.mockResolvedValue(baseTx);

      const result = await controller.findByStellarHash('hash-abc');

      expect(mockTransactionsService.findByStellarHash).toHaveBeenCalledWith('hash-abc');
      expect(result).toEqual(baseTx);
    });
  });

  describe('findByWallet', () => {
    it('delegates to service.findByWallet', async () => {
      mockTransactionsService.findByWallet.mockResolvedValue([baseTx]);

      const result = await controller.findByWallet('wallet-sender');

      expect(mockTransactionsService.findByWallet).toHaveBeenCalledWith('wallet-sender');
      expect(result).toEqual([baseTx]);
    });
  });
});
