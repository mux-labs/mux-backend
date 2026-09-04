/**
 * Wallet Orchestrator Integration Test Suite
 *
 * Exercises WalletCreationOrchestrator end-to-end without a live database:
 * - Success path: new wallet creation (PROVISIONING → ACTIVE)
 * - Idempotency: cache hit replays result, private key is never re-exposed
 * - Failure paths: user not found, DB failure, activation failure
 * - Security: private key absent from idempotency store and replayed response
 * - Unauthorized / invalid inputs return consistent error responses
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { PrismaClient } from '../generated/prisma/client';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeUser = (o: Record<string, any> = {}) => ({
  id: 'user-abc', authId: 'auth-abc', email: 'u@example.com',
  displayName: 'Test User', status: 'ACTIVE', authProvider: 'GOOGLE',
  lastLoginAt: NOW, createdAt: NOW, updatedAt: NOW, ...o,
});

const makeWallet = (o: Record<string, any> = {}) => ({
  id: 'wallet-abc', userId: 'user-abc', publicKey: 'GABC1234567890ABCDEF',
  encryptedSecret: 'enc-secret', encryptionVersion: 1, secretVersion: 1,
  keyVersion: 1, network: WalletNetwork.TESTNET, status: WalletStatus.ACTIVE,
  statusReason: null, statusChangedAt: NOW, rotatedFromId: null,
  createdAt: NOW, updatedAt: NOW, ...o,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

describe('WalletCreationOrchestrator (orchestrator integration)', () => {
  let orchestrator: WalletCreationOrchestrator;
  let encryptionService: jest.Mocked<Pick<EncryptionService, 'validateConfiguration' | 'deserializeAndDecrypt' | 'encryptAndSerialize'>>;
  let userService: jest.Mocked<Pick<IdempotentUserService, 'findUserById'>>;
  let keyManagement: jest.Mocked<Pick<KeyManagementService, 'generateKey'>>;
  let mockTx: any;
  let mockPrisma: any;

  beforeEach(async () => {
    mockTx = {
      wallet: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}), delete: jest.fn().mockResolvedValue({}) },
    };
    mockPrisma = {
      wallet: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(mockTx)),
    };

    encryptionService = {
      validateConfiguration: jest.fn().mockReturnValue(true),
      encryptAndSerialize: jest.fn().mockReturnValue('encrypted-key'),
      deserializeAndDecrypt: jest.fn().mockReturnValue('private-key-material'),
    } as any;
    userService = { findUserById: jest.fn() };
    keyManagement = {
      generateKey: jest.fn().mockResolvedValue({
        publicKey: 'GABC1234567890ABCDEF',
        encryptedData: 'encrypted-key',
        encryptionVersion: 1,
        keyVersion: 1,
        keyType: 'STELLAR_ED25519',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletCreationOrchestrator,
        { provide: EncryptionService, useValue: encryptionService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('https://horizon-testnet.stellar.org') } },
        { provide: IdempotentUserService, useValue: userService },
        { provide: KeyManagementService, useValue: keyManagement },
        { provide: PrismaClient, useValue: mockPrisma },
      ],
    }).compile();

    orchestrator = module.get(WalletCreationOrchestrator);
    (orchestrator as any).prisma = mockPrisma;
  });

  afterEach(() => jest.clearAllMocks());

  // -------------------------------------------------------------------------
  // 1. Success path: new wallet PROVISIONING → ACTIVE
  // -------------------------------------------------------------------------

  describe('new wallet creation', () => {
    const req: CreateWalletOrchestratorRequest = { userId: 'user-abc', network: WalletNetwork.TESTNET };

    beforeEach(() => {
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(makeWallet({ status: WalletStatus.PROVISIONING }));
      mockTx.wallet.update.mockResolvedValue(makeWallet({ status: WalletStatus.ACTIVE, statusReason: 'Wallet provisioned and activated' }));
    });

    it('returns isNewWallet=true and a non-empty privateKey on first creation', async () => {
      const result = await orchestrator.createWallet(req);
      expect(result.isNewWallet).toBe(true);
      expect(result.wallet.status).toBe(WalletStatus.ACTIVE);
      expect(result.privateKey).toBeTruthy();
    });

    it('writes wallet with PROVISIONING status, then updates to ACTIVE in the same transaction', async () => {
      await orchestrator.createWallet(req);
      expect(mockTx.wallet.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: WalletStatus.PROVISIONING }),
      }));
      expect(mockTx.wallet.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }));
    });

    it('returns existing wallet (isNewWallet=false, empty privateKey) when user already has one', async () => {
      mockTx.wallet.findFirst.mockResolvedValue(makeWallet());
      const result = await orchestrator.createWallet(req);
      expect(result.isNewWallet).toBe(false);
      expect(result.privateKey).toBe('');
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency — private key never stored or re-exposed
  // -------------------------------------------------------------------------

  describe('idempotency', () => {
    it('replays cached result without hitting the DB for wallet creation', async () => {
      const cached = { userId: 'user-abc', network: WalletNetwork.TESTNET, wallet: makeWallet(), isNewWallet: true, idempotencyKey: 'idem-1' };
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue({ key: 'idem-1', expiresAt: new Date(Date.now() + 60_000), response: cached });

      const result = await orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET, idempotencyKey: 'idem-1' });

      expect(result.isNewWallet).toBe(true);
      expect(result.wallet.id).toBe('wallet-abc');
      expect(result.privateKey).toBe(''); // never re-exposed
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });

    it('does NOT store the privateKey in the idempotency record', async () => {
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(makeWallet({ status: WalletStatus.PROVISIONING }));
      mockTx.wallet.update.mockResolvedValue(makeWallet());

      await orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET, idempotencyKey: 'idem-2' });

      const stored = mockTx.idempotencyRecord.create.mock.calls[0][0].data.response;
      expect(stored).not.toHaveProperty('privateKey');
    });

    it('throws ConflictException when idempotency key is reused for a different userId', async () => {
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.idempotencyRecord.findUnique.mockResolvedValue({
        key: 'idem-conflict',
        expiresAt: new Date(Date.now() + 60_000),
        response: { userId: 'other-user', network: WalletNetwork.TESTNET, wallet: makeWallet(), isNewWallet: true },
      });

      await expect(orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET, idempotencyKey: 'idem-conflict' })).rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Failure paths
  // -------------------------------------------------------------------------

  describe('failure paths', () => {
    it('throws NotFoundException when the user does not exist', async () => {
      userService.findUserById.mockResolvedValue(null);
      mockTx.wallet.findFirst.mockResolvedValue(null);
      await expect(orchestrator.createWallet({ userId: 'ghost', network: WalletNetwork.TESTNET })).rejects.toThrow(NotFoundException);
    });

    it('throws WalletOrchestrationError with phase=key-generation when key generation fails', async () => {
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      keyManagement.generateKey.mockRejectedValue(new Error('KMS unavailable'));

      const err: any = await orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET }).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('key-generation');
    });

    it('throws WalletOrchestrationError with phase=wallet-persist when DB create fails', async () => {
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockRejectedValue(new Error('DB write error'));

      const err: any = await orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET }).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('wallet-persist');
    });

    it('throws WalletOrchestrationError with phase=wallet-activation when activation update fails', async () => {
      userService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(null);
      mockTx.wallet.create.mockResolvedValue(makeWallet({ status: WalletStatus.PROVISIONING }));
      mockTx.wallet.update.mockRejectedValue(new Error('DB update error'));

      const err: any = await orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET }).catch((e) => e);
      expect(err).toBeInstanceOf(WalletOrchestrationError);
      expect(err.phase).toBe('wallet-activation');
    });

    it('wraps unknown DB transaction failures in WalletOrchestrationError', async () => {
      mockPrisma.$transaction.mockRejectedValue(new Error('connection lost'));
      userService.findUserById.mockResolvedValue(makeUser());

      await expect(orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET })).rejects.toThrow(WalletOrchestrationError);
    });

    it('re-throws ConflictException without wrapping', async () => {
      mockPrisma.$transaction.mockRejectedValue(new ConflictException('dup'));
      await expect(orchestrator.createWallet({ userId: 'user-abc', network: WalletNetwork.TESTNET })).rejects.toThrow(ConflictException);
    });
  });

  // -------------------------------------------------------------------------
  // 4. getWalletByUser / validateUserCanCreateWallet
  // -------------------------------------------------------------------------

  describe('helper queries', () => {
    it('getWalletByUser returns wallet when found', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(makeWallet());
      const w = await orchestrator.getWalletByUser('user-abc', WalletNetwork.TESTNET);
      expect(w!.id).toBe('wallet-abc');
    });

    it('getWalletByUser returns null when no wallet exists', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      expect(await orchestrator.getWalletByUser('user-abc', WalletNetwork.MAINNET)).toBeNull();
    });

    it('validateUserCanCreateWallet returns true when user has no wallet', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      await expect(orchestrator.validateUserCanCreateWallet('user-abc', WalletNetwork.TESTNET)).resolves.toBe(true);
    });

    it('validateUserCanCreateWallet returns false when wallet already exists', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(makeWallet());
      await expect(orchestrator.validateUserCanCreateWallet('user-abc', WalletNetwork.TESTNET)).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 5. cleanupStaleProvisioningWallets
  // -------------------------------------------------------------------------

  describe('cleanupStaleProvisioningWallets', () => {
    it('deletes stale PROVISIONING wallets older than the cutoff', async () => {
      mockPrisma.wallet.deleteMany.mockResolvedValue({ count: 2 });
      expect(await orchestrator.cleanupStaleProvisioningWallets(300_000)).toBe(2);
      expect(mockPrisma.wallet.deleteMany).toHaveBeenCalledWith({
        where: { status: WalletStatus.PROVISIONING, createdAt: { lt: expect.any(Date) } },
      });
    });

    it('returns 0 when there are no stale wallets', async () => {
      mockPrisma.wallet.deleteMany.mockResolvedValue({ count: 0 });
      expect(await orchestrator.cleanupStaleProvisioningWallets()).toBe(0);
    });
  });
});
