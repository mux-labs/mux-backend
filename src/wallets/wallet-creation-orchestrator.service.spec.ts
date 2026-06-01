import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';

// Prevent real PrismaClient from being instantiated (Prisma 7 requires an adapter)
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({})),
}));

// ---------------------------------------------------------------------------
// Shared mock wallet fixture
// ---------------------------------------------------------------------------

const mockWalletRow = {
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

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

const mockPrisma = {
  wallet: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findMany: jest.fn(),
  },
  idempotencyRecord: {
    findUnique: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockEncryptionService = {
  encryptAndSerialize: jest.fn(),
  deserializeAndDecrypt: jest.fn(),
  validateConfiguration: jest.fn(),
};

const mockConfigService = {
  get: jest.fn(),
};

const mockIdempotentUserService = {
  findUserById: jest.fn(),
  findOrCreateUser: jest.fn(),
  findUserByAuthId: jest.fn(),
  updateUser: jest.fn(),
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WalletCreationOrchestrator', () => {
  let orchestrator: WalletCreationOrchestrator;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: IdempotentUserService, useValue: mockIdempotentUserService },
      ],
    }).compile();

    orchestrator = module.get<WalletCreationOrchestrator>(
      WalletCreationOrchestrator,
    );

    // Wire mock prisma into the service directly (service creates its own
    // PrismaClient instance rather than relying on DI injection)
    (orchestrator as any).prisma = mockPrisma;

    jest.clearAllMocks();

    // Defaults
    mockEncryptionService.validateConfiguration.mockReturnValue(true);
    mockEncryptionService.encryptAndSerialize.mockReturnValue(
      'encrypted-private-key',
    );
    mockIdempotentUserService.findUserById.mockResolvedValue({
      id: 'user-123',
      authId: 'auth-123',
      status: 'ACTIVE',
      authProvider: 'EMAIL',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Default: no existing idempotency record
    mockPrisma.idempotencyRecord.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyRecord.create.mockResolvedValue({});
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

    it('should create a new wallet successfully', async () => {
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.createWallet(createRequest);

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
      // Private key must be non-empty on first creation
      expect(result.privateKey.length).toBeGreaterThan(0);

      expect(mockPrisma.wallet.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });
      expect(mockPrisma.wallet.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-123',
          publicKey: expect.any(String),
          encryptedSecret: 'encrypted-private-key',
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
          encryptionVersion: 1,
          secretVersion: 1,
        },
      });
      expect(mockEncryptionService.encryptAndSerialize).toHaveBeenCalledWith(
        expect.any(String),
      );
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
        'Wallet creation orchestration failed',
      );
    });

    it('should work without idempotency key', async () => {
      const requestWithoutIdempotency: CreateWalletOrchestratorRequest = {
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      };

      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(mockPrisma),
      );
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWalletRow);

      const result = await orchestrator.createWallet(requestWithoutIdempotency);

      expect(result).toEqual({
        wallet: expect.objectContaining({
          id: 'wallet-123',
          userId: 'user-123',
        }),
        privateKey: expect.any(String),
        isNewWallet: true,
        idempotencyKey: undefined,
      });
      // Idempotency record must NOT be stored when no key is provided
      expect(mockPrisma.idempotencyRecord.create).not.toHaveBeenCalled();
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
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue(mockWalletRow);

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
});
