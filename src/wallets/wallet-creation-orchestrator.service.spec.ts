import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  OrchestratorMetrics,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { ConfigService } from '@nestjs/config';
import { KeyType } from '../key-management/domain/key-types';
import { NotFoundException, ConflictException } from '@nestjs/common';

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
  idempotencyRecord: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
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

const mockConfigService = {
  get: jest.fn(),
};

// Mock IdempotentUserService
const mockIdempotentUserService = {
  findUserById: jest.fn(),
  findOrCreateUser: jest.fn(),
};

const mockKeyManagementService = {
  generateKey: jest.fn(),
};

const mockWalletRow = {
  id: 'wallet-123',
  userId: 'user-123',
  publicKey: 'GABC123DEF456',
  encryptedSecret: 'encrypted-private-key',
  encryptionVersion: 1,
  secretVersion: 1,
  network: WalletNetwork.TESTNET,
  status: 'ACTIVE',
  statusReason: 'Wallet provisioned and activated',
  statusChangedAt: new Date(),
  rotatedFromId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Global mock for fetch (Friendbot calls)
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('WalletCreationOrchestrator', () => {
  let orchestrator: WalletCreationOrchestrator;

  beforeEach(() => {
    jest.clearAllMocks();

    mockKeyManagementService.generateKey.mockResolvedValue({
      publicKey: 'GABC123DEF456',
      encryptedData: 'encrypted-private-key',
      encryptionVersion: 1,
      keyVersion: 1,
      keyType: KeyType.STELLAR_ED25519,
    });
    mockEncryptionService.deserializeAndDecrypt.mockReturnValue(
      'decrypted-private-key',
    );

    orchestrator = new WalletCreationOrchestrator(
      mockEncryptionService as any,
      mockConfigService as any,
      mockIdempotentUserService as any,
      mockKeyManagementService as any,
      mockPrisma as any,
    );

    // Setup default mock returns
    mockEncryptionService.validateConfiguration.mockReturnValue(true);

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

  // -------------------------------------------------------------------------
  // createWallet
  // -------------------------------------------------------------------------

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

      const result = await orchestrator.createWallet(createRequest);

      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'wallet-123',
          userId: 'user-123',
          publicKey: 'GABC123DEF456',
          network: WalletNetwork.TESTNET,
          status: WalletStatus.ACTIVE,
        }),
        privateKey: 'decrypted-private-key',
        isNewWallet: true,
        idempotencyKey: 'unique-key-123',
      });
      // Private key must be non-empty on first creation
      expect(result.privateKey.length).toBeGreaterThan(0);

      // Wallet is created with PROVISIONING status (Issue #188)
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-123',
          publicKey: 'GABC123DEF456',
          encryptedSecret: 'encrypted-private-key',
          network: WalletNetwork.TESTNET,
          status: 'PROVISIONING',
          encryptionVersion: 1,
          secretVersion: 1,
        }),
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

      expect(mockKeyManagementService.generateKey).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });
    });

    it('should store an idempotency record after creating a new wallet', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWalletRow);

      await orchestrator.createWallet(createRequest);

      expect(mockPrisma.idempotencyRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          key: 'unique-key-123',
          method: 'INTERNAL',
          endpoint: 'wallet-creation',
          statusCode: 200,
          expiresAt: expect.any(Date),
          response: expect.objectContaining({
            userId: 'user-123',
            network: WalletNetwork.TESTNET,
            isNewWallet: true,
          }),
        }),
      });
    });

    it('should NOT store the private key in the idempotency record', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWalletRow);

      await orchestrator.createWallet(createRequest);

      const storedPayload =
        mockPrisma.idempotencyRecord.create.mock.calls[0][0].data.response;
      expect(storedPayload).not.toHaveProperty('privateKey');
    });

    it('should return existing wallet if user already has one', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue({
        ...mockWalletRow,
        id: 'existing-wallet-123',
        publicKey: 'GEXISTING123',
        encryptedSecret: 'existing-encrypted-key',
      });

      const result = await orchestrator.createWallet(createRequest);

      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'existing-wallet-123',
          userId: 'user-123',
          publicKey: 'GEXISTING123',
        }),
        privateKey: '',
        isNewWallet: false,
        idempotencyKey: 'unique-key-123',
      });
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });

    it('should enforce one wallet per user per network', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.createWallet(createRequest);

      expect(result.isNewWallet).toBe(false);
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });

    it('should handle database transaction failures gracefully', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new Error('Database connection failed'),
      );

      await expect(orchestrator.createWallet(createRequest)).rejects.toThrow(
        WalletOrchestrationError,
      );
    });

    it('should work without idempotency key', async () => {
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

      const result = await orchestrator.createWallet(requestWithoutIdempotency);

      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'wallet-123',
          userId: 'user-123',
        }),
        privateKey: 'decrypted-private-key',
        isNewWallet: true,
        idempotencyKey: undefined,
      });
      // Idempotency record must NOT be stored when no key is provided
      expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
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

  describe('rollback behavior', () => {
    const createRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
    };

    it('should throw WalletOrchestrationError with phase=key-generation when key generation fails', async () => {
      mockKeyManagementService.generateKey.mockRejectedValue(
        new Error('Encryption key unavailable'),
      );

      mockPrisma.$transaction.mockImplementation(async (callback) =>
        callback(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      const err = await orchestrator
        .createWallet(createRequest)
        .catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('key-generation');
    });

    it('should throw WalletOrchestrationError with phase=wallet-persist when DB create fails', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback) =>
        callback(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockRejectedValue(new Error('DB write error'));

      const err = await orchestrator
        .createWallet(createRequest)
        .catch((e) => e);
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

      const err = await orchestrator
        .createWallet(createRequest)
        .catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('wallet-activation');
    });

    it('should preserve original error as cause on WalletOrchestrationError', async () => {
      const originalError = new Error('original DB error');
      mockPrisma.$transaction.mockRejectedValue(originalError);

      const err = await orchestrator
        .createWallet(createRequest)
        .catch((e) => e);
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

  describe('metrics logging', () => {
    let logSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      logSpy = jest
        .spyOn(orchestrator['logger'], 'log')
        .mockImplementation(() => {});
      warnSpy = jest
        .spyOn(orchestrator['logger'], 'warn')
        .mockImplementation(() => {});
    });

    const provisioningWallet = {
      id: 'wallet-123',
      userId: 'user-123',
      publicKey: 'GABC',
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
    const activeWallet = { ...provisioningWallet, status: WalletStatus.ACTIVE };

    it('should emit outcome=created with phase timings on new wallet', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) =>
        cb(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(provisioningWallet);
      mockPrisma.wallet.update.mockResolvedValue(activeWallet);

      await orchestrator.createWallet({
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      });

      const metricsCall = logSpy.mock.calls.find(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('[orchestrator-metrics]'),
      );
      expect(metricsCall).toBeDefined();
      const line: string = metricsCall[0];
      expect(line).toContain('outcome=created');
      expect(line).toContain('userId=user-123');
      expect(line).toContain('network=TESTNET');
      expect(line).toMatch(/durationMs=\d+/);
      expect(line).toMatch(/phase\.key-generation=\d+ms/);
      expect(line).toMatch(/phase\.key-encryption=\d+ms/);
      expect(line).toMatch(/phase\.wallet-persist=\d+ms/);
      expect(line).toMatch(/phase\.wallet-activation=\d+ms/);
    });

    it('should emit outcome=existing when wallet already exists', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) =>
        cb(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(activeWallet);

      await orchestrator.createWallet({
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      });

      const metricsCall = logSpy.mock.calls.find(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('[orchestrator-metrics]'),
      );
      expect(metricsCall[0]).toContain('outcome=existing');
    });

    it('should emit outcome=failed with failedPhase via warn on error', async () => {
      mockPrisma.$transaction.mockImplementation(async (cb) =>
        cb(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockRejectedValue(new Error('db error'));

      await orchestrator
        .createWallet({ userId: 'user-123', network: WalletNetwork.TESTNET })
        .catch(() => {});

      const metricsCall = warnSpy.mock.calls.find(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('[orchestrator-metrics]'),
      );
      expect(metricsCall).toBeDefined();
      const line: string = metricsCall[0];
      expect(line).toContain('outcome=failed');
      expect(line).toContain('failedPhase=wallet-persist');
    });

    it('should emit outcome=failed without failedPhase for non-orchestration errors', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('connection lost'));

      await orchestrator
        .createWallet({ userId: 'user-123', network: WalletNetwork.TESTNET })
        .catch(() => {});

      const metricsCall = warnSpy.mock.calls.find(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('[orchestrator-metrics]'),
      );
      expect(metricsCall[0]).toContain('outcome=failed');
      expect(metricsCall[0]).not.toContain('failedPhase=');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency behaviour
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    const createRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
      idempotencyKey: 'idem-key-abc',
    };

    it('should replay a cached result on a duplicate request', async () => {
      const cachedWallet = { ...mockWalletRow, id: 'cached-wallet-id' };
      const cachedEntry = {
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
        wallet: cachedWallet,
        isNewWallet: true,
        idempotencyKey: 'idem-key-abc',
      };

      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-abc',
        expiresAt: new Date(Date.now() + 60_000),
        response: cachedEntry,
      });

      const result = await orchestrator.createWallet(createRequest);

      expect(result.wallet.id).toBe('cached-wallet-id');
      expect(result.isNewWallet).toBe(true); // replayed from original
      expect(result.idempotencyKey).toBe('idem-key-abc');
      // Wallet creation must not happen again
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });

    it('should return empty privateKey on idempotency replay', async () => {
      const cachedEntry = {
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
        wallet: mockWalletRow,
        isNewWallet: true,
        idempotencyKey: 'idem-key-abc',
      };

      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-abc',
        expiresAt: new Date(Date.now() + 60_000),
        response: cachedEntry,
      });

      const result = await orchestrator.createWallet(createRequest);

      expect(result.privateKey).toBe('');
    });

    it('should replay the original isNewWallet value consistently', async () => {
      // Even if the wallet now "exists", the replayed result should reflect
      // the original isNewWallet: true from the first call
      const cachedEntry = {
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
        wallet: mockWalletRow,
        isNewWallet: true,
        idempotencyKey: 'idem-key-abc',
      };

      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-abc',
        expiresAt: new Date(Date.now() + 60_000),
        response: cachedEntry,
      });
      // Wallet exists in DB
      mockPrisma.wallet.findFirst.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.createWallet(createRequest);

      expect(result.isNewWallet).toBe(true);
    });

    it('should treat expired idempotency record as absent and proceed normally', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-abc',
        expiresAt: new Date(Date.now() - 1000), // expired
        response: {},
      });
      mockPrisma.idempotencyRecord.delete.mockResolvedValue({});
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.createWallet(createRequest);

      expect(result.isNewWallet).toBe(true);
      expect(mockPrisma.idempotencyRecord.delete).toHaveBeenCalledWith({
        where: { key: 'idem-key-abc' },
      });
    });

    it('should throw ConflictException when idempotency key is reused for a different userId', async () => {
      const cachedEntry = {
        userId: 'different-user',
        network: WalletNetwork.TESTNET,
        wallet: mockWalletRow,
        isNewWallet: true,
      };

      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-abc',
        expiresAt: new Date(Date.now() + 60_000),
        response: cachedEntry,
      });

      await expect(orchestrator.createWallet(createRequest)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ConflictException when idempotency key is reused for a different network', async () => {
      const cachedEntry = {
        userId: 'user-123',
        network: WalletNetwork.MAINNET, // different network
        wallet: mockWalletRow,
        isNewWallet: true,
      };

      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-abc',
        expiresAt: new Date(Date.now() + 60_000),
        response: cachedEntry,
      });

      await expect(orchestrator.createWallet(createRequest)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should silently handle P2002 when storing idempotency record (concurrent write)', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue({
        ...mockWalletRow,
        status: 'PROVISIONING',
      });
      mockPrisma.wallet.update.mockResolvedValue(mockWalletRow);

      const p2002 = Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
      });
      mockPrisma.idempotencyRecord.create.mockRejectedValue(p2002);

      // Should not throw even though idempotency storage failed
      const result = await orchestrator.createWallet(createRequest);
      expect(result.isNewWallet).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // validateUserCanCreateWallet
  // -------------------------------------------------------------------------

  describe('validateUserCanCreateWallet', () => {
    it('should return true if user has no existing wallet', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      const result = await orchestrator.validateUserCanCreateWallet(
        'user-123',
        WalletNetwork.TESTNET,
      );

      expect(result).toBe(true);
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });
    });

    it('should return false if user already has wallet', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.validateUserCanCreateWallet(
        'user-123',
        WalletNetwork.TESTNET,
      );

      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getWalletByUser
  // -------------------------------------------------------------------------

  describe('getWalletByUser', () => {
    it('should return wallet if found', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.getWalletByUser(
        'user-123',
        WalletNetwork.TESTNET,
      );

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
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      const result = await orchestrator.getWalletByUser(
        'user-123',
        WalletNetwork.TESTNET,
      );

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // onModuleInit
  // -------------------------------------------------------------------------

  describe('onModuleInit', () => {
    it('should throw error if encryption configuration is invalid', async () => {
      mockEncryptionService.validateConfiguration.mockReturnValue(false);

      await expect(orchestrator.onModuleInit()).rejects.toThrow(
        'Wallet creation orchestrator encryption configuration is invalid',
      );
    });

    it('should log successful initialization', async () => {
      mockEncryptionService.validateConfiguration.mockReturnValue(true);
      const logSpy = jest.spyOn((orchestrator as any).logger, 'log');

      await orchestrator.onModuleInit();

      expect(logSpy).toHaveBeenCalledWith(
        'Wallet creation orchestrator initialized with encryption validation passed',
      );
    });
  });

  describe('WalletOrchestrationError', () => {
    it('should set name, message, phase, and cause', () => {
      const cause = new Error('root cause');
      const err = new WalletOrchestrationError('msg', 'key-generation', cause);
      expect(err.name).toBe('WalletOrchestrationError');
      expect(err.message).toBe('msg');
      expect(err.phase).toBe('key-generation');
      expect(err.cause).toBe(cause);
    });

    it('should work without cause', () => {
      const err = new WalletOrchestrationError('msg', 'wallet-persist');
      expect(err.cause).toBeUndefined();
    });
  });

  describe('createWallet — user not found', () => {
    it('should throw NotFoundException when user does not exist', async () => {
      mockIdempotentUserService.findUserById.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (cb) =>
        cb(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      await expect(
        orchestrator.createWallet({
          userId: 'missing-user',
          network: WalletNetwork.TESTNET,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('createWallet — exception passthrough', () => {
    const createRequest: CreateWalletOrchestratorRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
    };

    it('should re-throw ConflictException without wrapping', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new ConflictException('conflict'),
      );

      await expect(orchestrator.createWallet(createRequest)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should re-throw NotFoundException without wrapping', async () => {
      mockPrisma.$transaction.mockRejectedValue(
        new NotFoundException('not found'),
      );

      await expect(orchestrator.createWallet(createRequest)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should re-throw WalletOrchestrationError without double-wrapping', async () => {
      const original = new WalletOrchestrationError('direct', 'key-generation');
      mockPrisma.$transaction.mockRejectedValue(original);

      const err = await orchestrator
        .createWallet(createRequest)
        .catch((e) => e);
      expect(err).toBe(original);
    });
  });

  describe('createWallet — idempotent outcome', () => {
    it('should emit outcome=idempotent when checkIdempotency returns a cached result', async () => {
      const cachedResult = {
        wallet: {
          id: 'wallet-cached',
          userId: 'user-123',
          publicKey: 'GCACHED',
          encryptedSecret: 'enc',
          encryptionVersion: 1,
          secretVersion: 1,
          network: WalletNetwork.TESTNET,
          status: WalletStatus.ACTIVE,
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        privateKey: '',
        isNewWallet: false,
        idempotencyKey: 'idem-key',
      };

      // Patch private checkIdempotency to return cached result
      jest
        .spyOn(orchestrator as any, 'checkIdempotency')
        .mockResolvedValue(cachedResult);

      const logSpy = jest
        .spyOn(orchestrator['logger'], 'log')
        .mockImplementation(() => {});
      mockPrisma.$transaction.mockImplementation(async (cb) =>
        cb(mockPrisma as any),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      const result = await orchestrator.createWallet({
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
        idempotencyKey: 'idem-key',
      });

      expect(result).toBe(cachedResult);
      const metricsCall = logSpy.mock.calls.find(
        ([msg]) =>
          typeof msg === 'string' && msg.includes('[orchestrator-metrics]'),
      );
      expect(metricsCall).toBeDefined();
      expect(metricsCall![0]).toContain('outcome=idempotent');
    });
  });

  describe('cleanupStaleProvisioningWallets — default cutoff', () => {
    it('should use 5-minute default cutoff when no argument provided', async () => {
      mockPrisma.wallet.deleteMany.mockResolvedValue({ count: 0 });

      await orchestrator.cleanupStaleProvisioningWallets();

      const call = mockPrisma.wallet.deleteMany.mock.calls[0][0];
      const cutoff: Date = call.where.createdAt.lt;
      const ageMs = Date.now() - cutoff.getTime();
      // Should be approximately 5 minutes (within 1 second tolerance)
      expect(ageMs).toBeGreaterThanOrEqual(4 * 60 * 1000);
      expect(ageMs).toBeLessThan(6 * 60 * 1000);
    });
  });
});
