/**
 * #785 — Wallet cache invalidation
 *
 * Verifies that WalletsService evicts the correct cache keys after rotate,
 * activate, and status-change operations so that downstream reads never
 * serve a stale PROVISIONING/ROTATING wallet.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletCacheService } from './wallet-cache.service';
import { CacheService } from '../common/cache/cache.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyManagementService } from '../key-management/key-management.service';

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockWalletPrisma = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};

const mockUserPrisma = { findUnique: jest.fn(), update: jest.fn() };
const mockTransactionPrisma = { count: jest.fn() };
const mockPrismaTransaction = jest.fn(async (cb: any) =>
  cb({ wallet: mockWalletPrisma }),
);

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    wallet: mockWalletPrisma,
    user: mockUserPrisma,
    transaction: mockTransactionPrisma,
    $transaction: mockPrismaTransaction,
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePrismaWallet(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wallet-abc',
    userId: 'user-xyz',
    publicKey: 'GABC123',
    encryptedSecret: 'enc-secret',
    encryptionVersion: 'v1',
    secretVersion: 1,
    keyVersion: 1,
    network: WalletNetwork.TESTNET,
    status: WalletStatus.ACTIVE,
    statusReason: null,
    statusChangedAt: null,
    rotatedFromId: null,
    successorId: null,
    nickname: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('#785 WalletsService — cache invalidation', () => {
  let service: WalletsService;
  let walletCacheService: WalletCacheService;
  let cacheService: CacheService;

  // Spy references
  let invalidateById: jest.SpyInstance;
  let invalidateByUser: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        WalletCacheService,
        CacheService,
        {
          provide: EncryptionService,
          useValue: {
            validateConfiguration: jest.fn().mockReturnValue(true),
            encryptAndSerialize: jest.fn().mockReturnValue('enc-data'),
            deserializeAndDecrypt: jest.fn().mockReturnValue('private-key'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('Test SDF Network ; September 2015'),
          },
        },
        {
          provide: KeyManagementService,
          useValue: {
            generateKey: jest.fn().mockResolvedValue({
              publicKey: 'GNEW999',
              encryptedData: 'enc-new',
              encryptionVersion: 'v1',
            }),
            rotateKey: jest.fn().mockResolvedValue({
              predecessorWalletId: 'wallet-old',
              successorWalletId: 'wallet-new',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);
    walletCacheService = module.get<WalletCacheService>(WalletCacheService);
    cacheService = module.get<CacheService>(CacheService);

    // Spy on both invalidation methods
    invalidateById = jest.spyOn(walletCacheService, 'invalidateWalletById');
    invalidateByUser = jest.spyOn(walletCacheService, 'invalidateWalletByUser');
  });

  afterEach(() => cacheService.clear());

  // ── activateWallet ──────────────────────────────────────────────────────────

  describe('activateWallet', () => {
    it('invalidates cache by id and by user+network after PROVISIONING → ACTIVE transition', async () => {
      const provisioning = makePrismaWallet({ status: 'PROVISIONING' });
      const activated = makePrismaWallet({ status: WalletStatus.ACTIVE });

      mockWalletPrisma.findUnique.mockResolvedValueOnce(provisioning);
      mockWalletPrisma.update.mockResolvedValueOnce(activated);

      // Pre-populate cache so we can confirm it gets evicted
      walletCacheService.setWalletById(
        provisioning.id as string,
        { ...provisioning, status: WalletStatus.PROVISIONING } as any,
      );
      walletCacheService.setWalletByUser(
        provisioning.userId as string,
        provisioning.network as string,
        { ...provisioning, status: WalletStatus.PROVISIONING } as any,
      );

      await service.activateWallet(provisioning.id as string);

      expect(invalidateById).toHaveBeenCalledWith(provisioning.id);
      expect(invalidateByUser).toHaveBeenCalledWith(
        provisioning.userId,
        provisioning.network,
      );

      // Cache entries must now be gone
      expect(walletCacheService.getWalletById(provisioning.id as string)).toBeNull();
      expect(
        walletCacheService.getWalletByUser(
          provisioning.userId as string,
          provisioning.network as string,
        ),
      ).toBeNull();
    });

    it('does NOT call invalidation when activate throws (wallet not found)', async () => {
      mockWalletPrisma.findUnique.mockResolvedValueOnce(null);

      await expect(service.activateWallet('missing-id')).rejects.toThrow(
        NotFoundException,
      );

      expect(invalidateById).not.toHaveBeenCalled();
      expect(invalidateByUser).not.toHaveBeenCalled();
    });
  });

  // ── updateWalletStatus ──────────────────────────────────────────────────────

  describe('updateWalletStatus', () => {
    it('invalidates cache after ACTIVE → SUSPENDED transition', async () => {
      const active = makePrismaWallet({ status: WalletStatus.ACTIVE });
      const suspended = makePrismaWallet({ status: WalletStatus.SUSPENDED });

      mockWalletPrisma.findUnique.mockResolvedValueOnce(active);
      mockWalletPrisma.update.mockResolvedValueOnce(suspended);

      walletCacheService.setWalletById(active.id as string, active as any);
      walletCacheService.setWalletByUser(
        active.userId as string,
        active.network as string,
        active as any,
      );

      await service.updateWalletStatus(active.id as string, WalletStatus.SUSPENDED, 'Policy violation');

      expect(invalidateById).toHaveBeenCalledWith(active.id);
      expect(invalidateByUser).toHaveBeenCalledWith(active.userId, active.network);

      expect(walletCacheService.getWalletById(active.id as string)).toBeNull();
      expect(
        walletCacheService.getWalletByUser(
          active.userId as string,
          active.network as string,
        ),
      ).toBeNull();
    });

    it('invalidates cache after ACTIVE → ARCHIVED transition', async () => {
      const active = makePrismaWallet({ status: WalletStatus.ACTIVE });
      const archived = makePrismaWallet({ status: WalletStatus.ARCHIVED });

      mockWalletPrisma.findUnique.mockResolvedValueOnce(active);
      mockWalletPrisma.update.mockResolvedValueOnce(archived);

      await service.updateWalletStatus(active.id as string, WalletStatus.ARCHIVED);

      expect(invalidateById).toHaveBeenCalledWith(active.id);
      expect(invalidateByUser).toHaveBeenCalledWith(active.userId, active.network);
    });

    it('does NOT call invalidation when wallet does not exist', async () => {
      mockWalletPrisma.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.updateWalletStatus('missing', WalletStatus.SUSPENDED),
      ).rejects.toThrow(NotFoundException);

      expect(invalidateById).not.toHaveBeenCalled();
      expect(invalidateByUser).not.toHaveBeenCalled();
    });
  });

  // ── rotateWalletKey ─────────────────────────────────────────────────────────

  describe('rotateWalletKey', () => {
    it('invalidates predecessor and successor cache entries after successful rotation', async () => {
      const predecessor = makePrismaWallet({
        id: 'wallet-old',
        status: WalletStatus.ACTIVE,
      });
      const successor = makePrismaWallet({
        id: 'wallet-new',
        publicKey: 'GNEW999',
        status: WalletStatus.ACTIVE,
      });

      // findUnique for the initial existence check
      mockWalletPrisma.findUnique
        .mockResolvedValueOnce(predecessor) // initial existence check
        .mockResolvedValueOnce(predecessor) // predecessor record after rotation
        .mockResolvedValueOnce(successor); // successor record after rotation

      // Pre-populate cache with stale predecessor data
      walletCacheService.setWalletById(predecessor.id as string, predecessor as any);
      walletCacheService.setWalletByUser(
        predecessor.userId as string,
        predecessor.network as string,
        predecessor as any,
      );

      await service.rotateWalletKey(predecessor.id as string);

      // Both predecessor and successor IDs must be evicted
      expect(invalidateById).toHaveBeenCalledWith('wallet-old');
      expect(invalidateById).toHaveBeenCalledWith('wallet-new');

      // User-network key for predecessor must also be evicted
      expect(invalidateByUser).toHaveBeenCalledWith(
        predecessor.userId,
        predecessor.network,
      );

      // Confirmed evicted
      expect(walletCacheService.getWalletById(predecessor.id as string)).toBeNull();
      expect(
        walletCacheService.getWalletByUser(
          predecessor.userId as string,
          predecessor.network as string,
        ),
      ).toBeNull();
    });

    it('does NOT call invalidation when rotation fails (wallet not found)', async () => {
      mockWalletPrisma.findUnique.mockResolvedValueOnce(null);

      await expect(service.rotateWalletKey('missing-id')).rejects.toThrow(
        NotFoundException,
      );

      expect(invalidateById).not.toHaveBeenCalled();
      expect(invalidateByUser).not.toHaveBeenCalled();
    });
  });
});
