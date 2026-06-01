import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';

// Mock Prisma Client
const mockPrisma = {
  wallet: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

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
  findUserByAuthId: jest.fn(),
  findOrCreateUser: jest.fn(),
};

describe('WalletCreationOrchestrator', () => {
  let orchestrator: WalletCreationOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();

    // Directly instantiate with mocks, passing mockPrisma as the optional prismaClient arg
    orchestrator = new WalletCreationOrchestrator(
      mockEncryptionService as any,
      mockConfigService as any,
      mockIdempotentUserService as any,
      mockPrisma as any,
    );

    // Setup default mock returns
    mockEncryptionService.validateConfiguration.mockReturnValue(true);
    mockEncryptionService.encryptAndSerialize.mockReturnValue(
      'encrypted-private-key',
    );
    mockIdempotentUserService.findUserById.mockResolvedValue({
      id: 'user-123',
      authId: 'auth-123',
      email: 'test@example.com',
      status: 'ACTIVE',
      authProvider: 'CLERK',
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

    it('should create a new wallet successfully', async () => {
      // Arrange
      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123DEF456',
        encryptedSecret: 'encrypted-private-key',
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: WalletStatus.PROVISIONING,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const activeWallet = { ...provisioningWallet, status: WalletStatus.ACTIVE };

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
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
          status: WalletStatus.ACTIVE,
        }),
        privateKey: expect.any(String),
        isNewWallet: true,
        idempotencyKey: 'unique-key-123',
      });

      // Wallet must be created in PROVISIONING first
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          status: WalletStatus.PROVISIONING,
        }),
      });

      // Then activated to ACTIVE in the same transaction
      expect(mockPrisma.wallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
        data: expect.objectContaining({ status: WalletStatus.ACTIVE }),
      });

      expect(mockEncryptionService.encryptAndSerialize).toHaveBeenCalledWith(
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
        WalletOrchestrationError,
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
        status: WalletStatus.PROVISIONING,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const activeWallet = { ...provisioningWallet, status: WalletStatus.ACTIVE };

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
  });

  describe('rollback behavior', () => {
    const createRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
    };

    it('should throw WalletOrchestrationError with phase=key-encryption when encryption fails', async () => {
      mockEncryptionService.encryptAndSerialize.mockImplementation(() => {
        throw new Error('Encryption key unavailable');
      });

      mockPrisma.$transaction.mockImplementation(async (callback) =>
        callback(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      const err = await orchestrator.createWallet(createRequest).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('key-encryption');
    });

    it('should throw WalletOrchestrationError with phase=wallet-persist when DB create fails', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback) =>
        callback(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockRejectedValue(new Error('DB write error'));

      const err = await orchestrator.createWallet(createRequest).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('wallet-persist');
    });

    it('should throw WalletOrchestrationError with phase=wallet-activation when activation update fails', async () => {
      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'enc',
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: WalletStatus.PROVISIONING,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrisma.$transaction.mockImplementation(async (callback) =>
        callback(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(provisioningWallet);
      mockPrisma.wallet.update.mockRejectedValue(new Error('DB update error'));

      const err = await orchestrator.createWallet(createRequest).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('wallet-activation');
    });

    it('should preserve original error as cause on WalletOrchestrationError', async () => {
      const originalError = new Error('original DB error');
      mockPrisma.$transaction.mockRejectedValue(originalError);

      const err = await orchestrator.createWallet(createRequest).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.cause).toBe(originalError);
    });
  });

  describe('cleanupStaleProvisioningWallets', () => {
    it('should delete PROVISIONING wallets older than the cutoff', async () => {
      mockPrisma.wallet.deleteMany.mockResolvedValue({ count: 3 });

      const count = await orchestrator.cleanupStaleProvisioningWallets(300_000);

      expect(count).toBe(3);
      expect(mockPrisma.wallet.deleteMany).toHaveBeenCalledWith({
        where: {
          status: WalletStatus.PROVISIONING,
          createdAt: { lt: expect.any(Date) },
        },
      });
    });

    it('should return 0 when no stale wallets exist', async () => {
      mockPrisma.wallet.deleteMany.mockResolvedValue({ count: 0 });

      const count = await orchestrator.cleanupStaleProvisioningWallets();
      expect(count).toBe(0);
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
