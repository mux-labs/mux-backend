import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletsService, CreateWalletRequest } from './wallets.service';
import { WalletNetwork } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';

// Shared mock Prisma wallet methods
const mockPrismaWallet = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findMany: jest.fn(),
};

// Mock the PrismaClient module so new PrismaClient() returns our mock
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    wallet: mockPrismaWallet,
  })),
}));

// Mock crypto sign to avoid actual key operations in tests
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    sign: jest.fn().mockReturnValue(Buffer.from('mock-signature')),
    generateKeyPairSync: jest.fn().mockReturnValue({
      publicKey: { export: jest.fn().mockReturnValue(Buffer.from('mock-public-key')) },
      privateKey: { export: jest.fn().mockReturnValue(Buffer.from('mock-private-key')) },
    }),
    createPrivateKey: jest.fn().mockReturnValue({}),
  };
});

describe('WalletsService', () => {
  let service: WalletsService;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockEncryptionService = {
      validateConfiguration: jest.fn().mockReturnValue(true),
      encryptAndSerialize: jest.fn(),
      deserializeAndDecrypt: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        {
          provide: EncryptionService,
          useValue: mockEncryptionService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should validate encryption configuration on startup', async () => {
      await service.onModuleInit();
      expect(encryptionService.validateConfiguration).toHaveBeenCalled();
    });

    it('should throw error if encryption validation fails', async () => {
      jest
        .spyOn(encryptionService, 'validateConfiguration')
        .mockReturnValue(false);

      await expect(service.onModuleInit()).rejects.toThrow(
        'Wallet encryption service configuration is invalid',
      );
    });
  });

  describe('createWallet', () => {
    const createWalletRequest: CreateWalletRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
    };

    it('should create a new wallet successfully', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'public-key-123',
        encryptedSecret: 'encrypted-secret',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaWallet.findFirst.mockResolvedValue(null);
      mockPrismaWallet.create.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('decrypted-private-key');

      const result = await service.createWallet(createWalletRequest);

      expect(result.wallet.id).toBe('wallet-123');
      expect(result.wallet.userId).toBe('user-123');
      expect(result.wallet.publicKey).toBe('public-key-123');
      expect(result.privateKey).toBe('decrypted-private-key');
      expect(keyManagementService.generateKey).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });
    });

    it('should throw ConflictException if user already has a wallet on the network', async () => {
      const existingWallet = {
        id: 'existing-wallet',
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      };

      mockPrismaWallet.findFirst.mockResolvedValue(existingWallet);

      await expect(service.createWallet(createWalletRequest)).rejects.toThrow(
        'User already has a wallet on TESTNET',
      );
    });

    it('should handle database errors gracefully', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(null);
      mockPrismaWallet.create.mockRejectedValue(new Error('Database error'));

      await expect(service.createWallet(createWalletRequest)).rejects.toThrow(
        'Wallet creation failed',
      );
    });
  });

  describe('getDecryptedPrivateKey', () => {
    it('should decrypt private key successfully', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('private-key-123');

      const result = await service.getDecryptedPrivateKey('wallet-123');

      expect(result).toBe('private-key-123');
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalledWith(
        'encrypted-secret',
      );
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(
        service.getDecryptedPrivateKey('non-existent'),
      ).rejects.toThrow('Wallet with ID non-existent not found');
    });

    it('should throw error if wallet is not active', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'SUSPENDED',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);

      await expect(
        service.getDecryptedPrivateKey('wallet-123'),
      ).rejects.toThrow('Cannot sign with wallet in status: SUSPENDED');
    });

    it('should handle decryption errors gracefully', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      await expect(
        service.getDecryptedPrivateKey('wallet-123'),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('should surface correct reason code in KeyDecryptionException', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Invalid key', 'INVALID_KEY');
        });

      let caught: KeyDecryptionException | undefined;
      try {
        await service.getDecryptedPrivateKey('wallet-123');
      } catch (e) {
        caught = e as KeyDecryptionException;
      }

      expect(caught).toBeInstanceOf(KeyDecryptionException);
      expect(caught!.reason).toBe('INVALID_KEY');
      expect(caught!.getStatus()).toBe(422);
    });
  });

  describe('signTransaction', () => {
    it('should sign transaction successfully', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('private-key-123');

      const result = await service.signTransaction(
        'wallet-123',
        'transaction-data',
      );

      expect(result.signature).toBeDefined();
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalled();
    });

    it('should handle signing errors gracefully', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(
        service.signTransaction('wallet-123', 'transaction-data'),
      ).rejects.toThrow('Transaction signing failed');
    });
  });

  describe('rotateWalletKey', () => {
    it('should rotate wallet key successfully', async () => {
      const existingWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'old-public-key',
        encryptedSecret: 'old-encrypted-secret',
        secretVersion: 1,
      };

      const updatedWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'new-public-key',
        encryptedSecret: 'new-encrypted-secret',
        secretVersion: 2,
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaWallet.findUnique.mockResolvedValue(existingWallet);
      mockPrismaWallet.update.mockResolvedValue(updatedWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('new-private-key');

      const result = await service.rotateWalletKey('wallet-123');

      expect(result.wallet.id).toBe('wallet-123');
      expect(result.wallet.secretVersion).toBe(2);
      expect(result.privateKey).toBe('new-private-key');
      expect(keyManagementService.generateKey).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { walletId: 'wallet-123', operation: 'rotation' },
      });
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.rotateWalletKey('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });
  });

  // #185: Wallet Status Endpoint
  describe('getWalletStatus', () => {
    it('should return wallet status', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);

      const result = await service.getWalletStatus('wallet-123');

      expect(result.id).toBe('wallet-123');
      expect(result.status).toBe('ACTIVE');
      expect(result.network).toBe(WalletNetwork.TESTNET);
      expect(result.publicKey).toBe('GABC123');
      expect(mockPrismaWallet.findUnique).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
      });
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.getWalletStatus('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });
  });

  // #188: Activate Wallet (PROVISIONING -> ACTIVE)
  describe('activateWallet', () => {
    it('should transition PROVISIONING to ACTIVE', async () => {
      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: 'PROVISIONING',
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const activeWallet = {
        ...provisioningWallet,
        status: 'ACTIVE',
        statusReason: 'Wallet provisioned and activated',
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaWallet.findUnique.mockResolvedValue(provisioningWallet);
      mockPrismaWallet.update.mockResolvedValue(activeWallet);

      const result = await service.activateWallet('wallet-123');

      expect(result.status).toBe('ACTIVE');
      expect(mockPrismaWallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
        data: expect.objectContaining({
          status: 'ACTIVE',
          statusReason: 'Wallet provisioned and activated',
        }),
      });
    });

    it('should throw error if wallet is not in PROVISIONING status', async () => {
      const activeWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaWallet.findUnique.mockResolvedValue(activeWallet);

      await expect(service.activateWallet('wallet-123')).rejects.toThrow(
        'Cannot activate wallet in status: ACTIVE',
      );
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.activateWallet('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });
  });

  // #189: Find wallets by userId
  describe('findWalletsByUserId', () => {
    it('should return all wallets for a userId', async () => {
      const wallets = [
        {
          id: 'wallet-1',
          userId: 'user-123',
          publicKey: 'GABC1',
          encryptedSecret: 'secret1',
          encryptionVersion: 1,
          secretVersion: 1,
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'wallet-2',
          userId: 'user-123',
          publicKey: 'GABC2',
          encryptedSecret: 'secret2',
          encryptionVersion: 1,
          secretVersion: 1,
          network: WalletNetwork.MAINNET,
          status: 'ACTIVE',
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaWallet.findMany.mockResolvedValue(wallets);

      const result = await service.findWalletsByUserId('user-123');

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user-123');
      expect(result[1].userId).toBe('user-123');
      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should return empty array if user has no wallets', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);

      const result = await service.findWalletsByUserId('user-no-wallets');

      expect(result).toEqual([]);
    });
  });
});
