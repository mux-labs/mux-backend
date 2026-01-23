import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletsService, CreateWalletRequest } from './wallets.service';
import { WalletNetwork } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { PrismaClient } from '../generated/prisma/client';

// Mock Prisma Client
const mockPrisma = {
  wallet: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('WalletsService', () => {
  let service: WalletsService;
  let encryptionService: EncryptionService;
  let configService: ConfigService;
  let prisma: PrismaClient;

  beforeEach(async () => {
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
        {
          provide: PrismaClient,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
    configService = module.get<ConfigService>(ConfigService);
    prisma = module.get<PrismaClient>(PrismaClient);
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
      jest.spyOn(encryptionService, 'validateConfiguration').mockReturnValue(false);
      
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

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWallet);
      jest.spyOn(encryptionService, 'encryptAndSerialize').mockReturnValue('encrypted-secret');

      const result = await service.createWallet(createWalletRequest);

      expect(result.wallet.id).toBe('wallet-123');
      expect(result.wallet.userId).toBe('user-123');
      expect(result.wallet.publicKey).toBe('public-key-123');
      expect(result.privateKey).toBeDefined();
      expect(encryptionService.encryptAndSerialize).toHaveBeenCalled();
    });

    it('should throw ConflictException if user already has a wallet on the network', async () => {
      const existingWallet = {
        id: 'existing-wallet',
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      };

      mockPrisma.wallet.findFirst.mockResolvedValue(existingWallet);

      await expect(service.createWallet(createWalletRequest)).rejects.toThrow(
        'User already has a wallet on TESTNET',
      );
    });

    it('should handle database errors gracefully', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockRejectedValue(new Error('Database error'));

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

      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      jest.spyOn(encryptionService, 'deserializeAndDecrypt').mockReturnValue('private-key-123');

      const result = await service.getDecryptedPrivateKey('wallet-123');

      expect(result).toBe('private-key-123');
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalledWith('encrypted-secret');
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.getDecryptedPrivateKey('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });

    it('should throw error if wallet is not active', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'SUSPENDED',
      };

      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);

      await expect(service.getDecryptedPrivateKey('wallet-123')).rejects.toThrow(
        'Cannot sign with wallet in status: SUSPENDED',
      );
    });

    it('should handle decryption errors gracefully', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      jest.spyOn(encryptionService, 'deserializeAndDecrypt').mockImplementation(() => {
        const error = new Error('Decryption failed') as any;
        error.code = 'DECRYPTION_FAILED';
        throw error;
      });

      await expect(service.getDecryptedPrivateKey('wallet-123')).rejects.toThrow(
        'Wallet key decryption failed - possible data corruption',
      );
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

      mockPrisma.wallet.findUnique.mockResolvedValue(mockWallet);
      jest.spyOn(encryptionService, 'deserializeAndDecrypt').mockReturnValue('private-key-123');

      const result = await service.signTransaction('wallet-123', 'transaction-data');

      expect(result.signature).toBeDefined();
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalled();
    });

    it('should handle signing errors gracefully', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.signTransaction('wallet-123', 'transaction-data')).rejects.toThrow(
        'Transaction signing failed',
      );
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

      mockPrisma.wallet.findUnique.mockResolvedValue(existingWallet);
      mockPrisma.wallet.update.mockResolvedValue(updatedWallet);
      jest.spyOn(encryptionService, 'encryptAndSerialize').mockReturnValue('new-encrypted-secret');

      const result = await service.rotateWalletKey('wallet-123');

      expect(result.wallet.id).toBe('wallet-123');
      expect(result.wallet.secretVersion).toBe(2);
      expect(result.privateKey).toBeDefined();
      expect(encryptionService.encryptAndSerialize).toHaveBeenCalled();
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.rotateWalletKey('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });
  });
});
