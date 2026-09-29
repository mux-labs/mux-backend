import { BalanceRepository } from './balance.repository';
import { AssetType, BalanceSyncStatus } from './domain/balance.model';

const WALLET_ID = 'wallet-1';
const NATIVE_ASSET = { type: AssetType.NATIVE };

const mockPrismaClient = {
  walletBalance: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
    upsert: jest.fn(),
    updateMany: jest.fn(),
  },
  wallet: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrismaClient),
}));

describe('BalanceRepository', () => {
  let repo: BalanceRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new BalanceRepository();
  });

  describe('findOne', () => {
    it('returns null when record does not exist', async () => {
      mockPrismaClient.walletBalance.findUnique.mockResolvedValue(null);
      const result = await repo.findOne(WALLET_ID, NATIVE_ASSET);
      expect(result).toBeNull();
    });

    it('maps prisma row to domain model', async () => {
      const row = {
        id: 'b1',
        walletId: WALLET_ID,
        assetType: AssetType.NATIVE,
        assetCode: null,
        assetIssuer: null,
        balance: '10.0',
        syncStatus: BalanceSyncStatus.SYNCED,
        lastSyncedAt: new Date(),
        lastSyncedLedger: 5,
        lastReconciledAt: null,
        reconciliationAttempts: 0,
        onChainBalance: '10.0',
        mismatchDetectedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrismaClient.walletBalance.findUnique.mockResolvedValue(row);
      const result = await repo.findOne(WALLET_ID, NATIVE_ASSET);
      expect(result).toMatchObject({ id: 'b1', balance: '10.0' });
    });
  });

  describe('upsertNativeZero', () => {
    it('upserts a zero NATIVE balance', async () => {
      mockPrismaClient.walletBalance.upsert.mockResolvedValue({});
      await repo.upsertNativeZero(WALLET_ID);
      expect(mockPrismaClient.walletBalance.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            balance: '0',
            assetType: AssetType.NATIVE,
          }),
          update: expect.objectContaining({ balance: '0' }),
        }),
      );
    });
  });

  describe('markFailed', () => {
    it('updates all wallet balances to FAILED status', async () => {
      mockPrismaClient.walletBalance.updateMany.mockResolvedValue({ count: 2 });
      await repo.markFailed(WALLET_ID);
      expect(mockPrismaClient.walletBalance.updateMany).toHaveBeenCalledWith({
        where: { walletId: WALLET_ID },
        data: { syncStatus: BalanceSyncStatus.FAILED },
      });
    });
  });

  describe('findActiveWallets', () => {
    it('queries only ACTIVE wallets', async () => {
      mockPrismaClient.wallet.findMany.mockResolvedValue([]);
      await repo.findActiveWallets();
      expect(mockPrismaClient.wallet.findMany).toHaveBeenCalledWith({
        where: { status: 'ACTIVE' },
      });
    });
  });
});
