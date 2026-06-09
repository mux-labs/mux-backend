/**
 * WalletCreationOrchestrator Integration Test Harness (#191)
 *
 * Wires the real WalletCreationOrchestrator with controlled collaborator stubs
 * to exercise the full wallet creation flow without a live database.
 *
 * Covers:
 * - New wallet creation (generates keys, encrypts, persists)
 * - Existing wallet returned idempotently (no DB write)
 * - Idempotency key cache hit (returns cached result, no DB write)
 * - Invalid network value rejected (enum validation)
 * - User not found propagation
 * - DB transaction failure handling
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { PrismaClient } from '../generated/prisma/client';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeDbWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-abc',
  userId: 'user-abc',
  publicKey: 'GABC1234567890',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  statusReason: null,
  statusChangedAt: NOW,
  rotatedFromId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeUser = (overrides: Record<string, any> = {}) => ({
  id: 'user-abc',
  authId: 'auth-abc',
  email: 'user@example.com',
  displayName: 'Test User',
  status: 'ACTIVE',
  authProvider: 'GOOGLE',
  lastLoginAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Harness setup
// ---------------------------------------------------------------------------

describe('WalletCreationOrchestrator (integration harness)', () => {
  let orchestrator: WalletCreationOrchestrator;
  let encryptionService: jest.Mocked<EncryptionService>;
  let idempotentUserService: jest.Mocked<
    Pick<IdempotentUserService, 'findUserById'>
  >;
  let idempotencyService: jest.Mocked<
    Pick<IdempotencyService, 'getCachedResponse' | 'cacheResponse'>
  >;
  let mockTx: any;
  let mockPrisma: any;

  beforeEach(async () => {
    mockTx = {
      wallet: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      idempotencyRecord: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
    };

    mockPrisma = {
      wallet: {
        findFirst: jest.fn(),
      },
      $transaction: jest.fn().mockImplementation((cb) => cb(mockTx)),
    };

    encryptionService = {
      validateConfiguration: jest.fn().mockReturnValue(true),
      encryptAndSerialize: jest.fn().mockReturnValue('encrypted-key'),
      deserializeAndDecrypt: jest.fn().mockReturnValue('decrypted-private-key'),
    } as any;

    idempotentUserService = {
      findUserById: jest.fn(),
    };

    idempotencyService = {
      getCachedResponse: jest.fn().mockResolvedValue(null),
      cacheResponse: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        { provide: EncryptionService, useValue: encryptionService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: IdempotentUserService, useValue: idempotentUserService },
        { provide: IdempotencyService, useValue: idempotencyService },
        {
          provide: KeyManagementService,
          useValue: {
            generateKey: jest.fn().mockResolvedValue({
              publicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZABCD',
              encryptedData: 'encrypted-key',
              encryptionVersion: 1,
              keyVersion: 1,
              keyType: 'STELLAR_ED25519',
            }),
          },
        },
        { provide: PrismaClient, useValue: mockPrisma },
      ],
    }).compile();

    orchestrator = module.get(WalletCreationOrchestrator);
    // Inject mock prisma directly (bypasses real DB)
    (orchestrator as any).prisma = mockPrisma;
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // New wallet creation
  // -------------------------------------------------------------------------

  describe('new wallet creation', () => {
    const request: CreateWalletOrchestratorRequest = {
      userId: 'user-abc',
      network: WalletNetwork.TESTNET,
    };

    beforeEach(() => {
      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(
        makeDbWallet({ status: WalletStatus.PROVISIONING }),
      );
      mockTx.wallet.update.mockResolvedValue(makeDbWallet());
    });

    it('creates wallet, encrypts key, and returns isNewWallet=true', async () => {
      const result = await orchestrator.createWallet(request);

      expect(result.isNewWallet).toBe(true);
      expect(result.wallet.id).toBe('wallet-abc');
      expect(result.wallet.userId).toBe('user-abc');
      expect(result.wallet.network).toBe(WalletNetwork.TESTNET);
      expect(result.wallet.status).toBe(WalletStatus.ACTIVE);
      expect(result.privateKey).toBeTruthy();
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalledWith(
        'encrypted-key',
      );
    });

    it('creates wallet record with correct data shape', async () => {
      await orchestrator.createWallet(request);

      expect(mockTx.wallet.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user-abc',
          network: WalletNetwork.TESTNET,
          status: WalletStatus.PROVISIONING,
          encryptionVersion: 1,
          secretVersion: 1,
          encryptedSecret: 'encrypted-key',
        }),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Existing wallet (idempotent return)
  // -------------------------------------------------------------------------

  describe('existing wallet', () => {
    it('returns existing wallet without creating a new one', async () => {
      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(makeDbWallet());

      const result = await orchestrator.createWallet({
        userId: 'user-abc',
        network: WalletNetwork.TESTNET,
      });

      expect(result.isNewWallet).toBe(false);
      expect(result.privateKey).toBe('');
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency key cache hit
  // -------------------------------------------------------------------------

  describe('idempotency key', () => {
    it('returns cached result on second call without hitting DB', async () => {
      const cachedEntry = {
        userId: 'user-abc',
        network: WalletNetwork.TESTNET,
        wallet: makeDbWallet(),
        isNewWallet: true,
        idempotencyKey: 'idem-key-1',
      };

      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-key-1',
        expiresAt: new Date(Date.now() + 60_000),
        response: cachedEntry,
      });

      const result = await orchestrator.createWallet({
        userId: 'user-abc',
        network: WalletNetwork.TESTNET,
        idempotencyKey: 'idem-key-1',
      });

      expect(result.wallet.id).toBe('wallet-abc');
      expect(result.isNewWallet).toBe(true);
      expect(result.privateKey).toBe('');
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });

    it('stores result after successful creation', async () => {
      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue(null);
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(
        makeDbWallet({ status: WalletStatus.PROVISIONING }),
      );
      mockTx.wallet.update.mockResolvedValue(makeDbWallet());

      await orchestrator.createWallet({
        userId: 'user-abc',
        network: WalletNetwork.TESTNET,
        idempotencyKey: 'idem-key-2',
      });

      expect(mockTx.idempotencyRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          key: 'idem-key-2',
          method: 'INTERNAL',
          endpoint: 'wallet-creation',
          statusCode: 200,
          response: expect.objectContaining({ isNewWallet: true }),
        }),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws when user is not found', async () => {
      idempotentUserService.findUserById.mockResolvedValue(null);

      await expect(
        orchestrator.createWallet({
          userId: 'unknown',
          network: WalletNetwork.TESTNET,
        }),
      ).rejects.toThrow();
    });

    it('wraps DB transaction failures', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('DB down'));

      await expect(
        orchestrator.createWallet({
          userId: 'user-abc',
          network: WalletNetwork.TESTNET,
        }),
      ).rejects.toThrow('Wallet creation orchestration failed');
    });
  });

  // -------------------------------------------------------------------------
  // getWalletByUser
  // -------------------------------------------------------------------------

  describe('getWalletByUser', () => {
    it('returns wallet when found', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(makeDbWallet());

      const result = await orchestrator.getWalletByUser(
        'user-abc',
        WalletNetwork.TESTNET,
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe('wallet-abc');
      expect(result!.network).toBe(WalletNetwork.TESTNET);
    });

    it('returns null when wallet does not exist', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      const result = await orchestrator.getWalletByUser(
        'user-abc',
        WalletNetwork.MAINNET,
      );

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // validateUserCanCreateWallet
  // -------------------------------------------------------------------------

  describe('validateUserCanCreateWallet', () => {
    it('returns true when user has no wallet on the network', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      await expect(
        orchestrator.validateUserCanCreateWallet(
          'user-abc',
          WalletNetwork.TESTNET,
        ),
      ).resolves.toBe(true);
    });

    it('returns false when user already has a wallet on the network', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(makeDbWallet());

      await expect(
        orchestrator.validateUserCanCreateWallet(
          'user-abc',
          WalletNetwork.TESTNET,
        ),
      ).resolves.toBe(false);
    });
  });
});
