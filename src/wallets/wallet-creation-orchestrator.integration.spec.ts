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
import { NotFoundException } from '@nestjs/common';
import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { CacheService } from '../common/cache/cache.service';
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

    const mockCacheService = {
      get: jest.fn(),
      set: jest.fn(),
      delete: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        { provide: EncryptionService, useValue: encryptionService },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: IdempotentUserService, useValue: idempotentUserService },
        { provide: IdempotencyService, useValue: idempotencyService },
        { provide: CacheService, useValue: mockCacheService },
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
  // Request ID propagation
  // -------------------------------------------------------------------------

  describe('request id propagation', () => {
    it('should propagate requestId through createWallet log output', async () => {
      const logSpy = jest.spyOn(orchestrator['logger'], 'log').mockImplementation(() => {});
      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(
        makeDbWallet({ status: WalletStatus.PROVISIONING }),
      );
      mockTx.wallet.update.mockResolvedValue(makeDbWallet());

      await orchestrator.createWallet(
        { userId: 'user-abc', network: WalletNetwork.TESTNET },
        'integ-req-id-789',
      );

      const startLog = logSpy.mock.calls.find(
        ([msg]) => typeof msg === 'string' && msg.includes('Starting wallet creation'),
      );
      expect(startLog).toBeDefined();
      expect(startLog![0]).toContain('requestId=integ-req-id-789');
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

  // ─────────────────────────────────────────────────────────────────────────
  // Stale / invalid state handling
  // ─────────────────────────────────────────────────────────────────────────

  describe('stale and invalid state handling', () => {
    it('treats an expired idempotency record as absent and creates a new wallet', async () => {
      // Record exists but expiresAt is in the past
      const staleRecord = {
        key: 'idem-stale',
        expiresAt: new Date(Date.now() - 1000), // already expired
        response: {
          userId: 'user-abc',
          network: WalletNetwork.TESTNET,
          wallet: makeDbWallet(),
          isNewWallet: true,
          idempotencyKey: 'idem-stale',
        },
      };

      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue(staleRecord);
      mockTx.idempotencyRecord.delete = jest.fn().mockResolvedValue({});
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(
        makeDbWallet({ status: WalletStatus.PROVISIONING }),
      );
      mockTx.wallet.update.mockResolvedValue(makeDbWallet());

      const result = await orchestrator.createWallet({
        userId: 'user-abc',
        network: WalletNetwork.TESTNET,
        idempotencyKey: 'idem-stale',
      });

      // Should have created a brand-new wallet, not replayed stale data
      expect(result.isNewWallet).toBe(true);
      expect(mockTx.wallet.create).toHaveBeenCalled();
      expect(mockTx.idempotencyRecord.delete).toHaveBeenCalledWith({
        where: { key: 'idem-stale' },
      });
    });

    it('throws ConflictException when idempotency key is reused for a different userId', async () => {
      const conflictRecord = {
        key: 'idem-conflict',
        expiresAt: new Date(Date.now() + 60_000),
        response: {
          userId: 'different-user',
          network: WalletNetwork.TESTNET,
          wallet: makeDbWallet(),
          isNewWallet: true,
        },
      };

      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue(conflictRecord);

      await expect(
        orchestrator.createWallet({
          userId: 'user-abc', // different from cached userId
          network: WalletNetwork.TESTNET,
          idempotencyKey: 'idem-conflict',
        }),
      ).rejects.toThrow(/[Ii]dempotency/);
    });

    it('throws ConflictException when idempotency key is reused for a different network', async () => {
      const conflictRecord = {
        key: 'idem-net-conflict',
        expiresAt: new Date(Date.now() + 60_000),
        response: {
          userId: 'user-abc',
          network: WalletNetwork.MAINNET, // different network
          wallet: makeDbWallet({ network: WalletNetwork.MAINNET }),
          isNewWallet: true,
        },
      };

      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue(conflictRecord);

      await expect(
        orchestrator.createWallet({
          userId: 'user-abc',
          network: WalletNetwork.TESTNET, // different from cached network
          idempotencyKey: 'idem-net-conflict',
        }),
      ).rejects.toThrow(/[Ii]dempotency/);
    });

    it('silently handles P2002 on idempotency record create (concurrent write)', async () => {
      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue(null);
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(
        makeDbWallet({ status: WalletStatus.PROVISIONING }),
      );
      mockTx.wallet.update.mockResolvedValue(makeDbWallet());
      // Simulate a concurrent write (unique constraint violation)
      mockTx.idempotencyRecord.create.mockRejectedValue(
        Object.assign(new Error('Unique constraint'), { code: 'P2002' }),
      );

      // Should NOT throw — P2002 on idempotency record is non-fatal
      await expect(
        orchestrator.createWallet({
          userId: 'user-abc',
          network: WalletNetwork.TESTNET,
          idempotencyKey: 'idem-concurrent',
        }),
      ).resolves.toMatchObject({ isNewWallet: true });
    });

    it('does not propagate a failed idempotency store when it is non-P2002', async () => {
      idempotentUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue(null);
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(
        makeDbWallet({ status: WalletStatus.PROVISIONING }),
      );
      mockTx.wallet.update.mockResolvedValue(makeDbWallet());
      // Non-P2002 storage error — should still be swallowed (non-fatal)
      mockTx.idempotencyRecord.create.mockRejectedValue(
        new Error('Disk full'),
      );

      await expect(
        orchestrator.createWallet({
          userId: 'user-abc',
          network: WalletNetwork.TESTNET,
          idempotencyKey: 'idem-disk-full',
        }),
      ).resolves.toMatchObject({ isNewWallet: true });
    });

    it('returns cached result without DB query', async () => {
      const cached = makeDbWallet({ id: 'cached-wallet' });
      (orchestrator as any).cacheService = {
        get: jest.fn().mockReturnValue(cached),
        set: jest.fn(),
      };

      const result = await orchestrator.getWalletByUser(
        'user-abc',
        WalletNetwork.TESTNET,
      );

      expect(result!.id).toBe('cached-wallet');
      expect(mockPrisma.wallet.findFirst).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getWalletStatus
  // ─────────────────────────────────────────────────────────────────────────

  describe('getWalletStatus', () => {
    it('returns wallet status fields for an existing wallet', async () => {
      mockPrisma.wallet = {
        ...mockPrisma.wallet,
        findUnique: jest.fn().mockResolvedValue(makeDbWallet()),
      };

      const status = await orchestrator.getWalletStatus('wallet-abc');

      expect(status.id).toBe('wallet-abc');
      expect(status.status).toBe(WalletStatus.ACTIVE);
      expect(status.network).toBe(WalletNetwork.TESTNET);
      expect(status.publicKey).toBeDefined();
    });

    it('throws NotFoundException for an unknown walletId', async () => {
      mockPrisma.wallet = {
        ...mockPrisma.wallet,
        findUnique: jest.fn().mockResolvedValue(null),
      };

      await expect(
        orchestrator.getWalletStatus('unknown-wallet'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // findWalletsByUserId
  // ─────────────────────────────────────────────────────────────────────────

  describe('findWalletsByUserId', () => {
    it('returns all wallets for a user', async () => {
      mockPrisma.wallet = {
        ...mockPrisma.wallet,
        findMany: jest.fn().mockResolvedValue([
          makeDbWallet(),
          makeDbWallet({ id: 'wallet-2', network: WalletNetwork.MAINNET }),
        ]),
      };

      const wallets = await orchestrator.findWalletsByUserId('user-abc');

      expect(wallets).toHaveLength(2);
      expect(wallets[0].userId).toBe('user-abc');
    });

    it('returns empty array when user has no wallets', async () => {
      mockPrisma.wallet = {
        ...mockPrisma.wallet,
        findMany: jest.fn().mockResolvedValue([]),
      };

      const wallets = await orchestrator.findWalletsByUserId('user-no-wallets');

      expect(wallets).toEqual([]);
    });
  });
});
