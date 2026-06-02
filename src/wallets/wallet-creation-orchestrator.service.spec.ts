import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';

// Mock Prisma Client
const mockPrisma = {
  wallet: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

// Mock PrismaClient module
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

// Need to import for TypeScript type (jest.mock hoists the import)
import { PrismaClient } from '../generated/prisma/client';

// Mock Encryption Service
const mockEncryptionService = {
  encryptAndSerialize: jest.fn(),
  deserializeAndDecrypt: jest.fn(),
  validateConfiguration: jest.fn(),
};

// Mock Config Service
const mockConfigService = {
  get: jest.fn(),
};

// Mock IdempotentUserService
const mockIdempotentUserService = {
  findUserById: jest.fn(),
  findOrCreateUser: jest.fn(),
};

// Global mock for fetch (Friendbot calls)
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('WalletCreationOrchestrator', () => {
  let orchestrator: WalletCreationOrchestrator;
  let prismaClient: jest.Mocked<PrismaClient>;
  let encryptionService: jest.Mocked<EncryptionService>;
  let configService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        {
          provide: PrismaClient,
          useValue: mockPrisma,
        },
        {
          provide: EncryptionService,
          useValue: mockEncryptionService,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: IdempotentUserService,
          useValue: mockIdempotentUserService,
        },
      ],
    }).compile();

    orchestrator = module.get<WalletCreationOrchestrator>(
      WalletCreationOrchestrator,
    );
    prismaClient = module.get(PrismaClient);
    encryptionService = module.get(EncryptionService);
    configService = module.get(ConfigService);

    // Reset all mocks
    jest.clearAllMocks();

    // Setup default mock returns
    mockEncryptionService.validateConfiguration.mockReturnValue(true);
    mockEncryptionService.encryptAndSerialize.mockReturnValue(
      'encrypted-private-key',
    );

    // Mock fetch to succeed by default (Friendbot)
    mockFetch.mockResolvedValue({
      ok: true,
    });

    // Mock config to return testnet horizon URL
    mockConfigService.get.mockReturnValue(
      'https://horizon-testnet.stellar.org',
    );

    // Mock IdempotentUserService
    mockIdempotentUserService.findUserById.mockResolvedValue({
      id: 'user-123',
      authId: 'auth-123',
      email: 'test@example.com',
      displayName: 'Test User',
      status: 'ACTIVE',
      authProvider: 'CLERK',
      lastLoginAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  describe('createWallet', () => {
    const createRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
      idempotencyKey: 'unique-key-123',
    };

    it('should create a new wallet successfully with PROVISIONING -> ACTIVE flow', async () => {
      // Arrange
      // Wallet returned after creation (PROVISIONING status)
      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123DEF456',
        encryptedSecret: 'encrypted-private-key',
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

      // Wallet returned after activation (ACTIVE status)
      const activeWallet = {
        ...provisioningWallet,
        status: 'ACTIVE',
        statusReason: 'Wallet provisioned and activated',
        statusChangedAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(null); // No existing wallet
      mockPrisma.wallet.create.mockResolvedValue(provisioningWallet);
      mockPrisma.wallet.update.mockResolvedValue(activeWallet);

      // Act
      const result = await orchestrator.createWallet(createRequest);

      // Assert
      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'wallet-123',
          userId: 'user-123',
          publicKey: 'GABC123DEF456',
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
        }),
        privateKey: expect.any(String),
        isNewWallet: true,
        idempotencyKey: 'unique-key-123',
      });

      // Wallet is created with PROVISIONING status (Issue #188)
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          publicKey: expect.any(String),
          encryptedSecret: 'encrypted-private-key',
          network: WalletNetwork.TESTNET,
          status: 'PROVISIONING',
          encryptionVersion: 1,
          secretVersion: 1,
        },
      });

      // Wallet is then transitioned to ACTIVE (Issue #188)
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
        data: expect.objectContaining({
          status: 'ACTIVE',
          statusReason: 'Wallet provisioned and activated',
        }),
      });

      // Friendbot was called to fund the testnet account (Issue #187)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('friendbot.stellar.org'),
        { method: 'GET' },
      );

      expect(encryptionService.encryptAndSerialize).toHaveBeenCalledWith(
        expect.any(String),
      );
    });

    it('should return existing wallet if user already has one', async () => {
      // Arrange
      const existingWallet = {
        id: 'existing-wallet-123',
        userId: 'user-123',
        publicKey: 'GEXISTING123',
        encryptedSecret: 'existing-encrypted-key',
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

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(existingWallet);

      // Act
      const result = await orchestrator.createWallet(createRequest);

      // Assert
      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'existing-wallet-123',
          userId: 'user-123',
          publicKey: 'GEXISTING123',
        }),
        privateKey: '', // Empty for existing wallets
        isNewWallet: false,
        idempotencyKey: 'unique-key-123',
      });

      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });

    it('should enforce one wallet per user per network', async () => {
      // Arrange
      const existingWallet = {
        id: 'existing-wallet-123',
        userId: 'user-123',
        publicKey: 'GEXISTING123',
        encryptedSecret: 'existing-encrypted-key',
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

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(existingWallet);

      // Act
      const result = await orchestrator.createWallet(createRequest);

      // Assert
      expect(result.isNewWallet).toBe(false);
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });

    it('should handle database transaction failures gracefully', async () => {
      // Arrange
      mockPrisma.$transaction.mockRejectedValue(
        new Error('Database connection failed'),
      );

      // Act & Assert
      await expect(orchestrator.createWallet(createRequest)).rejects.toThrow(
        'Wallet creation orchestration failed',
      );
    });

    it('should work without idempotency key', async () => {
      // Arrange
      const requestWithoutIdempotency: CreateWalletOrchestratorRequest = {
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      };

      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123DEF456',
        encryptedSecret: 'encrypted-private-key',
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

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(provisioningWallet);
      mockPrisma.wallet.update.mockResolvedValue(activeWallet);

      // Act
      const result = await orchestrator.createWallet(requestWithoutIdempotency);

      // Assert
      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'wallet-123',
          userId: 'user-123',
        }),
        privateKey: expect.any(String),
        isNewWallet: true,
        idempotencyKey: undefined,
      });
    });

    it('should continue even if Friendbot funding fails', async () => {
      // Arrange
      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123DEF456',
        encryptedSecret: 'encrypted-private-key',
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

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(provisioningWallet);
      mockPrisma.wallet.update.mockResolvedValue(activeWallet);

      // Friendbot fails with a network error
      mockFetch.mockRejectedValue(new Error('Network error'));

      // Act
      const result = await orchestrator.createWallet(createRequest);

      // Assert - wallet creation still succeeds despite Friendbot failure
      expect(result.isNewWallet).toBe(true);
      expect(result.wallet.status).toBe('ACTIVE');
    });
  });

  describe('validateUserCanCreateWallet', () => {
    it('should return true if user has no existing wallet', async () => {
      // Arrange
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      // Act
      const result = await orchestrator.validateUserCanCreateWallet(
        'user-123',
        WalletNetwork.TESTNET,
      );

      // Assert
      expect(result).toBe(true);
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });
    });

    it('should return false if user already has wallet', async () => {
      // Arrange
      const existingWallet = {
        id: 'existing-wallet-123',
        userId: 'user-123',
        publicKey: 'GEXISTING123',
        encryptedSecret: 'existing-encrypted-key',
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

      mockPrisma.wallet.findFirst.mockResolvedValue(existingWallet);

      // Act
      const result = await orchestrator.validateUserCanCreateWallet(
        'user-123',
        WalletNetwork.TESTNET,
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('getWalletByUser', () => {
    it('should return wallet if found', async () => {
      // Arrange
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123DEF456',
        encryptedSecret: 'encrypted-private-key',
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

      mockPrisma.wallet.findFirst.mockResolvedValue(mockWallet);

      // Act
      const result = await orchestrator.getWalletByUser(
        'user-123',
        WalletNetwork.TESTNET,
      );

      // Assert
      expect(result).toEqual(
        expect.objectContaining({
          id: 'wallet-123',
          userId: 'user-123',
          publicKey: 'GABC123DEF456',
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
        }),
      );
    });

    it('should return null if wallet not found', async () => {
      // Arrange
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      // Act
      const result = await orchestrator.getWalletByUser(
        'user-123',
        WalletNetwork.TESTNET,
      );

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('onModuleInit', () => {
    it('should throw error if encryption configuration is invalid', async () => {
      // Arrange
      mockEncryptionService.validateConfiguration.mockReturnValue(false);

      // Act & Assert
      await expect(orchestrator.onModuleInit()).rejects.toThrow(
        'Wallet creation orchestrator encryption configuration is invalid',
      );
    });

    it('should log successful initialization', async () => {
      // Arrange
      mockEncryptionService.validateConfiguration.mockReturnValue(true);
      const logSpy = jest.spyOn(orchestrator['logger'], 'log');

      // Act
      await orchestrator.onModuleInit();

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Wallet creation orchestrator initialized with encryption validation passed',
      );
    });
  });
});
