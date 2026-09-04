import { ConflictException, NotFoundException } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletNetwork } from './domain/wallet.model';

/**
 * Unit tests for the address uniqueness feature (Issue #4).
 *
 * Covers:
 *  - WalletsService.findByPublicKey()        – success and 404 paths
 *  - WalletsService.isPublicKeyTaken()       – taken and free paths
 *  - WalletsService.createWallet()           – Prisma P2002 → ConflictException
 */
describe('WalletsService – address uniqueness', () => {
  const mockPrisma = {
    wallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const baseWallet = {
    id: 'wallet-1',
    userId: 'user-1',
    publicKey: 'GABCDEF123',
    encryptedSecret: 'enc',
    encryptionVersion: 1,
    secretVersion: 1,
    keyVersion: 1,
    network: 'TESTNET',
    status: 'ACTIVE',
    statusReason: null,
    statusChangedAt: new Date(),
    rotatedFromId: null,
    successorId: null,
    nickname: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /** Build a minimal WalletsService with only the methods under test. */
  function makeService() {
    const service = {
      prisma: mockPrisma,
      logger: { logWithContext: jest.fn(), warn: jest.fn(), error: jest.fn() },
      mapPrismaWalletToDomain: (w: any) => ({
        ...w,
        network: w.network as WalletNetwork,
        status: w.status,
        nickname: w.nickname ?? null,
      }),
      toPublicWallet: (w: any) => {
        const { encryptedSecret: _enc, ...pub } = w;
        return pub;
      },
      findByPublicKey: WalletsService.prototype.findByPublicKey,
      isPublicKeyTaken: WalletsService.prototype.isPublicKeyTaken,
    } as any;
    return service as WalletsService;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // findByPublicKey
  // ---------------------------------------------------------------------------
  describe('findByPublicKey()', () => {
    it('returns the matching wallet when the public key exists on the network', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(baseWallet);
      const service = makeService();

      const result = await service.findByPublicKey('GABCDEF123', WalletNetwork.TESTNET);

      expect(mockPrisma.wallet.findUnique).toHaveBeenCalledWith({
        where: {
          network_publicKey: {
            network: WalletNetwork.TESTNET,
            publicKey: 'GABCDEF123',
          },
        },
      });
      expect(result.publicKey).toBe('GABCDEF123');
      // encryptedSecret must not be returned
      expect((result as any).encryptedSecret).toBeUndefined();
    });

    it('throws NotFoundException when no wallet has that public key on the network', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      const service = makeService();

      await expect(
        service.findByPublicKey('GNOTEXIST', WalletNetwork.TESTNET),
      ).rejects.toThrow(NotFoundException);
    });

    it('does not return a wallet from a different network', async () => {
      // findUnique on MAINNET should not find the TESTNET wallet
      mockPrisma.wallet.findUnique.mockResolvedValue(null);
      const service = makeService();

      await expect(
        service.findByPublicKey('GABCDEF123', WalletNetwork.MAINNET),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // isPublicKeyTaken
  // ---------------------------------------------------------------------------
  describe('isPublicKeyTaken()', () => {
    it('returns true when a wallet with that public key already exists', async () => {
      mockPrisma.wallet.count.mockResolvedValue(1);
      const service = makeService();

      const taken = await service.isPublicKeyTaken('GABCDEF123', WalletNetwork.TESTNET);

      expect(taken).toBe(true);
      expect(mockPrisma.wallet.count).toHaveBeenCalledWith({
        where: { publicKey: 'GABCDEF123', network: WalletNetwork.TESTNET },
      });
    });

    it('returns false when no wallet has that public key', async () => {
      mockPrisma.wallet.count.mockResolvedValue(0);
      const service = makeService();

      const taken = await service.isPublicKeyTaken('GNEW', WalletNetwork.TESTNET);

      expect(taken).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // createWallet – Prisma P2002 unique constraint violation
  // ---------------------------------------------------------------------------
  describe('createWallet() – DB unique constraint violation', () => {
    it('throws ConflictException when Prisma raises P2002 for publicKey', async () => {
      // Simulate: no pre-existing wallet for (userId, network)
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      // Simulate Prisma P2002 unique constraint error on publicKey
      const prismaError = Object.assign(new Error('Unique constraint failed'), {
        code: 'P2002',
        meta: { target: ['publicKey', 'network'] },
      });
      mockPrisma.$transaction.mockRejectedValue(prismaError);

      // Build a minimal service that exercises the real createWallet() method
      const service = {
        prisma: mockPrisma,
        logger: { logWithContext: jest.fn(), warn: jest.fn(), error: jest.fn() },
        encryptionService: {
          deserializeAndDecrypt: jest.fn().mockReturnValue('PRIVATE_KEY'),
          validateConfiguration: jest.fn().mockReturnValue(true),
        },
        keyManagementService: {
          generateKey: jest.fn().mockResolvedValue({
            publicKey: 'GPUBLIC',
            encryptedData: 'ENC_DATA',
            encryptionVersion: 1,
          }),
        },
        walletRetryService: undefined,
        walletApiMetrics: {
          record: jest.fn(),
        },
        webhookEventEmitter: undefined,
        generateKeyWithRetry: jest.fn().mockResolvedValue({
          publicKey: 'GPUBLIC',
          encryptedData: 'ENC_DATA',
          encryptionVersion: 1,
        }),
        recordMetric: jest.fn(),
        emitDomainEvent: jest.fn(),
        mapPrismaWalletToDomain: jest.fn(),
        createWallet: WalletsService.prototype.createWallet,
      } as any;

      await expect(
        service.createWallet({ userId: 'user-1', network: WalletNetwork.TESTNET }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
