import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { TransactionStatus } from './domain/transaction.model';

const mockTransactionsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findByWallet: jest.fn(),
  findByStellarHash: jest.fn(),
  findOne: jest.fn(),
  updateStatus: jest.fn(),
};

const allowGuard = { canActivate: () => true };

describe('TransactionsController', () => {
  let controller: TransactionsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TransactionsController],
      providers: [
        { provide: TransactionsService, useValue: mockTransactionsService },
      ],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue(allowGuard)
      .overrideGuard(RateLimitGuard)
      .useValue(allowGuard)
      .compile();

    controller = module.get<TransactionsController>(TransactionsController);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /transactions/wallet/:walletId', () => {
    it('should call findByWallet with walletId and no pagination', async () => {
      mockTransactionsService.findByWallet.mockResolvedValue([]);

      await controller.findByWallet('wallet-1', undefined, undefined);

      expect(mockTransactionsService.findByWallet).toHaveBeenCalledWith('wallet-1', {
        limit: undefined,
        offset: undefined,
      });
    });

    it('should parse and pass limit and offset', async () => {
      mockTransactionsService.findByWallet.mockResolvedValue([]);

      await controller.findByWallet('wallet-1', '10', '20');

      expect(mockTransactionsService.findByWallet).toHaveBeenCalledWith('wallet-1', {
        limit: 10,
        offset: 20,
      });
    });

    it('should return the result from the service', async () => {
      const tx = { id: 'tx-1', status: TransactionStatus.PENDING };
      mockTransactionsService.findByWallet.mockResolvedValue([tx]);

      const result = await controller.findByWallet('wallet-1', undefined, undefined);

      expect(result).toEqual([tx]);
    });
  });

  describe('GET /transactions', () => {
    it('should call findAll with parsed filters', async () => {
      mockTransactionsService.findAll.mockResolvedValue([]);

      await controller.findAll('wallet-sender', undefined, undefined, '5', '0');

      expect(mockTransactionsService.findAll).toHaveBeenCalledWith({
        senderWalletId: 'wallet-sender',
        receiverWalletId: undefined,
        status: undefined,
        limit: 5,
        offset: 0,
      });
    });
  });
});
