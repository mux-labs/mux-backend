import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { BalanceIndexerController } from './balance-indexer.controller';
import { BalanceIndexerService } from './balance-indexer.service';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';
import { PaginationDto } from '../common/dto/pagination.dto';
import { BalanceFilterDto } from './dto/balance-filter.dto';
import { GetBalanceQueryDto } from './dto/get-balance.query';
import { SyncBalancesDto } from './dto/sync-balances.dto';
import { ReconcileBalanceDto } from './dto/reconcile-balance.dto';

const WALLET_ID = '123e4567-e89b-12d3-a456-426614174000';

const mockBalance = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  walletId: WALLET_ID,
  assetType: AssetType.NATIVE,
  assetCode: null,
  assetIssuer: null,
  balance: '1000.5000000',
  syncStatus: BalanceSyncStatus.SYNCED,
  lastSyncedAt: new Date('2024-06-24T12:34:56.789Z'),
  lastSyncedLedger: 47261234,
  lastReconciledAt: new Date('2024-06-24T11:30:00.000Z'),
  reconciliationAttempts: 2,
  onChainBalance: '1000.5000000',
  mismatchDetectedAt: null,
  createdAt: new Date('2024-06-24T10:00:00.000Z'),
  updatedAt: new Date('2024-06-24T12:34:56.789Z'),
};

const mockSyncResult = {
  walletId: WALLET_ID,
  balancesUpdated: 5,
  mismatchesFound: 0,
  syncStatus: BalanceSyncStatus.SYNCED,
  lastSyncedAt: new Date('2024-06-24T12:34:56.789Z'),
};

describe('BalanceIndexerController', () => {
  let controller: BalanceIndexerController;
  let service: jest.Mocked<BalanceIndexerService>;

  const mockService = {
    getAllBalances: jest.fn(),
    getBalance: jest.fn(),
    syncWalletBalances: jest.fn(),
    syncAllWallets: jest.fn(),
    reconcileBalance: jest.fn(),
    reconcileAllBalances: jest.fn(),
    syncWalletBalancesWithRetry: jest.fn(),
    detectStaleBalances: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BalanceIndexerController],
      providers: [
        { provide: BalanceIndexerService, useValue: mockService },
      ],
    }).compile();

    controller = module.get<BalanceIndexerController>(
      BalanceIndexerController,
    );
    service = module.get(BalanceIndexerService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ─── getWalletBalances ────────────────────────────────────────────────────

  describe('getWalletBalances', () => {
    it('returns paginated balances with default pagination', async () => {
      mockService.getAllBalances.mockResolvedValue([mockBalance]);

      const result = await controller.getWalletBalances(
        WALLET_ID,
        { page: 1, limit: 20 },
        {},
      );

      expect(result).toEqual({
        data: [mockBalance],
        total: 1,
        page: 1,
        limit: 20,
      });
    });

    it('applies assetType filter', async () => {
      const creditBalance = { ...mockBalance, assetType: AssetType.CREDIT_ALPHANUM4, assetCode: 'USD' };
      mockService.getAllBalances.mockResolvedValue([mockBalance, creditBalance]);

      const result = await controller.getWalletBalances(
        WALLET_ID,
        { page: 1, limit: 20 },
        { assetType: AssetType.CREDIT_ALPHANUM4 },
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].assetCode).toBe('USD');
      expect(result.total).toBe(1);
    });

    it('applies assetCode filter', async () => {
      const usdBalance = { ...mockBalance, assetCode: 'USD' };
      const eurBalance = { ...mockBalance, assetCode: 'EUR' };
      mockService.getAllBalances.mockResolvedValue([usdBalance, eurBalance]);

      const result = await controller.getWalletBalances(
        WALLET_ID,
        { page: 1, limit: 20 },
        { assetCode: 'USD' },
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].assetCode).toBe('USD');
    });

    it('respects custom pagination limits', async () => {
      const balances = Array.from({ length: 50 }, (_, i) => ({
        ...mockBalance,
        id: `bal-${i}`,
      }));
      mockService.getAllBalances.mockResolvedValue(balances);

      const result = await controller.getWalletBalances(
        WALLET_ID,
        { page: 2, limit: 10 },
        {},
      );

      expect(result.data).toHaveLength(10);
      expect(result.data[0].id).toBe('bal-10');
      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.total).toBe(50);
    });

    it('returns empty data for wallet with no balances', async () => {
      mockService.getAllBalances.mockResolvedValue([]);

      const result = await controller.getWalletBalances(
        WALLET_ID,
        { page: 1, limit: 20 },
        {},
      );

      expect(result).toEqual({
        data: [],
        total: 0,
        page: 1,
        limit: 20,
      });
    });
  });

  // ─── getWalletAssetBalance ────────────────────────────────────────────────

  describe('getWalletAssetBalance', () => {
    it('returns balance when found', async () => {
      mockService.getBalance.mockResolvedValue(mockBalance);

      const result = await controller.getWalletAssetBalance(
        WALLET_ID,
        { assetType: AssetType.NATIVE },
      );

      expect(result).toEqual(mockBalance);
      expect(mockService.getBalance).toHaveBeenCalledWith(
        WALLET_ID,
        expect.objectContaining({ type: AssetType.NATIVE }),
      );
    });

    it('defaults to NATIVE asset when assetType not provided', async () => {
      mockService.getBalance.mockResolvedValue(mockBalance);

      await controller.getWalletAssetBalance(WALLET_ID, {});

      expect(mockService.getBalance).toHaveBeenCalledWith(
        WALLET_ID,
        expect.objectContaining({ type: AssetType.NATIVE }),
      );
    });

    it('includes asset code and issuer for credit assets', async () => {
      const creditBalance = {
        ...mockBalance,
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
      };
      mockService.getBalance.mockResolvedValue(creditBalance);

      await controller.getWalletAssetBalance(WALLET_ID, {
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
      });

      expect(mockService.getBalance).toHaveBeenCalledWith(
        WALLET_ID,
        expect.objectContaining({
          type: AssetType.CREDIT_ALPHANUM4,
          code: 'USD',
          issuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
        }),
      );
    });

    it('throws NotFoundException when balance not found', async () => {
      mockService.getBalance.mockResolvedValue(null);

      await expect(
        controller.getWalletAssetBalance(WALLET_ID, { assetType: AssetType.NATIVE }),
      ).rejects.toThrow('Balance not found');
    });
  });

  // ─── syncWalletBalances ───────────────────────────────────────────────────

  describe('syncWalletBalances', () => {
    it('syncs with default forceRefresh=false', async () => {
      mockService.syncWalletBalances.mockResolvedValue(mockSyncResult);

      const result = await controller.syncWalletBalances(
        WALLET_ID,
        new SyncBalancesDto(),
      );

      expect(result).toEqual(mockSyncResult);
      expect(mockService.syncWalletBalances).toHaveBeenCalledWith({
        walletId: WALLET_ID,
        forceRefresh: false,
      });
    });

    it('respects forceRefresh flag', async () => {
      mockService.syncWalletBalances.mockResolvedValue(mockSyncResult);

      const syncDto = new SyncBalancesDto();
      syncDto.forceRefresh = true;

      await controller.syncWalletBalances(WALLET_ID, syncDto);

      expect(mockService.syncWalletBalances).toHaveBeenCalledWith({
        walletId: WALLET_ID,
        forceRefresh: true,
      });
    });
  });

  // ─── reconcileWalletBalance ───────────────────────────────────────────────

  describe('reconcileWalletBalance', () => {
    it('reconciles NATIVE asset', async () => {
      const mockReconciliation = {
        walletId: WALLET_ID,
        assetType: AssetType.NATIVE,
        assetCode: null,
        assetIssuer: null,
        indexedBalance: '1000.5000000',
        onChainBalance: '1000.5000000',
        matches: true,
      };
      mockService.reconcileBalance.mockResolvedValue(mockReconciliation);

      const reconcileDto: ReconcileBalanceDto = {
        assetType: AssetType.NATIVE,
      };

      const result = await controller.reconcileWalletBalance(
        WALLET_ID,
        reconcileDto,
      );

      expect(result.matches).toBe(true);
      expect(mockService.reconcileBalance).toHaveBeenCalledWith(
        WALLET_ID,
        expect.objectContaining({ type: AssetType.NATIVE }),
      );
    });

    it('reconciles credit asset with code and issuer', async () => {
      const mockReconciliation = {
        walletId: WALLET_ID,
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
        indexedBalance: '500.0000000',
        onChainBalance: '500.0000000',
        matches: true,
      };
      mockService.reconcileBalance.mockResolvedValue(mockReconciliation);

      const reconcileDto: ReconcileBalanceDto = {
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
      };

      await controller.reconcileWalletBalance(WALLET_ID, reconcileDto);

      expect(mockService.reconcileBalance).toHaveBeenCalledWith(
        WALLET_ID,
        expect.objectContaining({
          type: AssetType.CREDIT_ALPHANUM4,
          code: 'USD',
          issuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
        }),
      );
    });

    it('returns mismatch details when balances do not match', async () => {
      const mockReconciliation = {
        walletId: WALLET_ID,
        assetType: AssetType.NATIVE,
        assetCode: null,
        assetIssuer: null,
        indexedBalance: '1000.0000000',
        onChainBalance: '1100.0000000',
        matches: false,
        difference: '-100.0000000',
      };
      mockService.reconcileBalance.mockResolvedValue(mockReconciliation);

      const reconcileDto: ReconcileBalanceDto = {
        assetType: AssetType.NATIVE,
      };

      const result = await controller.reconcileWalletBalance(
        WALLET_ID,
        reconcileDto,
      );

      expect(result.matches).toBe(false);
      expect(result.difference).toBeDefined();
    });
  });

  // ─── syncAllWallets ───────────────────────────────────────────────────────

  describe('syncAllWallets', () => {
    it('calls service syncAllWallets', async () => {
      const mockResult = {
        walletsProcessed: 10,
        balancesUpdated: 45,
        mismatchesFound: 2,
      };
      mockService.syncAllWallets.mockResolvedValue(mockResult);

      const result = await controller.syncAllWallets();

      expect(result).toEqual(mockResult);
      expect(mockService.syncAllWallets).toHaveBeenCalled();
    });
  });

  // ─── reconcileAllBalances ─────────────────────────────────────────────────

  describe('reconcileAllBalances', () => {
    it('calls service reconcileAllBalances', async () => {
      const mockResult = {
        walletsProcessed: 10,
        mismatchesFound: 2,
      };
      mockService.reconcileAllBalances.mockResolvedValue(mockResult);

      const result = await controller.reconcileAllBalances();

      expect(result).toEqual(mockResult);
      expect(mockService.reconcileAllBalances).toHaveBeenCalled();
    });
  });

  // ─── detectStaleBalances ──────────────────────────────────────────────────

  describe('detectStaleBalances', () => {
    it('returns stale assets when detected', async () => {
      const mockResult = {
        walletId: WALLET_ID,
        staleAssets: ['NATIVE', 'USD/CREDIT_ALPHANUM4'],
        staleSince: new Date('2024-06-24T10:00:00.000Z'),
      };
      mockService.detectStaleBalances.mockResolvedValue(mockResult);

      const result = await controller.detectStaleBalances(WALLET_ID);

      expect(result).toEqual(mockResult);
      expect(result.staleAssets).toHaveLength(2);
    });

    it('returns empty stale assets when none detected', async () => {
      const mockResult = {
        walletId: WALLET_ID,
        staleAssets: [],
        staleSince: null,
      };
      mockService.detectStaleBalances.mockResolvedValue(mockResult);

      const result = await controller.detectStaleBalances(WALLET_ID);

      expect(result.staleAssets).toHaveLength(0);
    });
  });
});
