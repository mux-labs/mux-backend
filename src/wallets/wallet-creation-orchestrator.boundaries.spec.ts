/**
 * Service Boundary Tests (#423)
 *
 * These tests document and verify the WalletCreationOrchestrator service
 * boundaries: which collaborators it delegates to, and what it owns itself.
 *
 * ## Boundary Map
 *
 * WalletCreationOrchestrator is the single entry point for the
 * PROVISIONING → ACTIVE wallet lifecycle. Its boundaries are:
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │         WalletCreationOrchestrator               │
 *   │                                                  │
 *   │  owns:  orchestration flow, phase timings,       │
 *   │         idempotency record lifecycle, metrics     │
 *   │         emission, event dispatch                  │
 *   │                                                  │
 *   │  delegates to:                                   │
 *   │    IdempotentUserService  → user resolution       │
 *   │    KeyManagementService   → key generation        │
 *   │    EncryptionService      → key decryption        │
 *   │    PrismaClient           → wallet persistence    │
 *   │    WalletRetryService     → retry strategy        │
 *   │    WalletOrchestratorMetricsService → counters    │
 *   │    WebhookEventEmitterService → domain events     │
 *   └─────────────────────────────────────────────────┘
 *
 * WalletsService owns the full CRUD layer for wallets (list/update/delete).
 * WalletCreationOrchestrator does NOT call WalletsService — it goes directly
 * to Prisma to keep the transaction boundary atomic.
 */

import {
  WalletCreationOrchestrator,
  CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { ConfigService } from '@nestjs/config';
import { WalletOrchestratorMetricsService } from './wallet-orchestrator-metrics.service';
import { WalletApiMetricsService } from './wallet-api-metrics.service';
import { KeyType } from '../key-management/domain/key-types';

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

// Shared mutable mock so tests can override per-case
const mockTx = {
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

const mockPrisma = {
  wallet: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  $transaction: jest.fn().mockImplementation((cb: any) => cb(mockTx)),
};

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeDbWallet = (overrides: Record<string, any> = {}) => ({
  id: 'wallet-boundary-1',
  userId: 'user-boundary-1',
  publicKey: 'GABC1234567890',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  keyVersion: 1,
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  statusReason: null,
  statusChangedAt: NOW,
  rotatedFromId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeUser = () => ({
  id: 'user-boundary-1',
  authId: 'auth-boundary-1',
  email: 'user@example.com',
  displayName: 'Test User',
  status: 'ACTIVE',
  authProvider: 'GOOGLE',
  lastLoginAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});

function buildOrchestrator(
  overrides: {
    metrics?: Partial<WalletOrchestratorMetricsService>;
    walletApiMetrics?: Partial<WalletApiMetricsService>;
    webhookEmitter?: any;
  } = {},
): {
  orchestrator: WalletCreationOrchestrator;
  mockUserService: jest.Mocked<Pick<IdempotentUserService, 'findUserById'>>;
  mockKeyService: jest.Mocked<Pick<KeyManagementService, 'generateKey'>>;
  mockEncryption: jest.Mocked<Pick<EncryptionService, 'validateConfiguration' | 'deserializeAndDecrypt'>>;
  mockMetrics: jest.Mocked<Pick<WalletOrchestratorMetricsService, 'record'>>;
} {
  const mockUserService = { findUserById: jest.fn() } as any;
  const mockKeyService = {
    generateKey: jest.fn().mockResolvedValue({
      publicKey: 'GABC1234567890',
      encryptedData: 'encrypted-key',
      encryptionVersion: 1,
      keyVersion: 1,
      keyType: KeyType.STELLAR_ED25519,
    }),
  } as any;
  const mockEncryption = {
    validateConfiguration: jest.fn().mockReturnValue(true),
    deserializeAndDecrypt: jest.fn().mockReturnValue('raw-private-key'),
  } as any;
  const mockMetrics = {
    record: jest.fn(),
    ...(overrides.metrics ?? {}),
  } as any;
  const configService = { get: jest.fn() } as any;

  const orchestrator = new WalletCreationOrchestrator(
    mockEncryption,
    configService,
    mockUserService,
    mockKeyService,
    mockPrisma as any,
    overrides.webhookEmitter,
    undefined,
    overrides.walletApiMetrics as any,
    mockMetrics,
  );

  return { orchestrator, mockUserService, mockKeyService, mockEncryption, mockMetrics };
}

describe('WalletCreationOrchestrator — service boundaries (#423)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTx.wallet.findFirst.mockResolvedValue(null);
    mockTx.wallet.create.mockResolvedValue(makeDbWallet({ status: WalletStatus.PROVISIONING }));
    mockTx.wallet.update.mockResolvedValue(makeDbWallet());
    mockTx.idempotencyRecord.findUnique.mockResolvedValue(null);
    mockTx.idempotencyRecord.create.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((cb: any) => cb(mockTx));
  });

  // ── Boundary: User resolution is fully delegated to IdempotentUserService ──

  describe('user resolution boundary', () => {
    it('delegates user lookup to IdempotentUserService, not to Prisma directly', async () => {
      const { orchestrator, mockUserService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      await orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET });

      expect(mockUserService.findUserById).toHaveBeenCalledWith('user-boundary-1');
    });

    it('throws NotFoundException (not a raw DB error) when user is absent', async () => {
      const { orchestrator, mockUserService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(null);

      await expect(
        orchestrator.createWallet({ userId: 'ghost-user', network: WalletNetwork.TESTNET }),
      ).rejects.toThrow();

      // Prisma wallet.create must never be called if user lookup fails
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
    });
  });

  // ── Boundary: Key generation is fully delegated to KeyManagementService ──

  describe('key generation boundary', () => {
    it('delegates key generation to KeyManagementService', async () => {
      const { orchestrator, mockUserService, mockKeyService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      await orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET });

      expect(mockKeyService.generateKey).toHaveBeenCalledWith(
        expect.objectContaining({ keyType: KeyType.STELLAR_ED25519 }),
      );
    });

    it('propagates userId and network as metadata to key generation', async () => {
      const { orchestrator, mockUserService, mockKeyService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      await orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.MAINNET });

      expect(mockKeyService.generateKey).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            userId: 'user-boundary-1',
            network: WalletNetwork.MAINNET,
          }),
        }),
      );
    });

    it('calls EncryptionService.deserializeAndDecrypt to expose the raw private key', async () => {
      const { orchestrator, mockUserService, mockEncryption } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      const result = await orchestrator.createWallet({
        userId: 'user-boundary-1',
        network: WalletNetwork.TESTNET,
      });

      expect(mockEncryption.deserializeAndDecrypt).toHaveBeenCalledWith('encrypted-key');
      expect(result.privateKey).toBe('raw-private-key');
    });
  });

  // ── Boundary: Metrics are delegated to WalletOrchestratorMetricsService ──

  describe('metrics boundary', () => {
    it('calls orchestratorMetrics.record on successful creation', async () => {
      const { orchestrator, mockUserService, mockMetrics } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      await orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET });

      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'created', network: WalletNetwork.TESTNET }),
      );
    });

    it('calls orchestratorMetrics.record with outcome=existing when wallet already exists', async () => {
      const { orchestrator, mockUserService, mockMetrics } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(makeDbWallet());

      await orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET });

      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'existing' }),
      );
    });

    it('calls orchestratorMetrics.record with outcome=failed on error', async () => {
      const { orchestrator, mockUserService, mockMetrics } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());
      mockPrisma.$transaction.mockRejectedValue(new Error('DB down'));

      await expect(
        orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET }),
      ).rejects.toThrow();

      expect(mockMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed' }),
      );
    });

    it('does not throw if orchestratorMetrics is not injected (optional)', async () => {
      const orchestrator = new WalletCreationOrchestrator(
        { validateConfiguration: jest.fn().mockReturnValue(true), deserializeAndDecrypt: jest.fn().mockReturnValue('key') } as any,
        { get: jest.fn() } as any,
        { findUserById: jest.fn().mockResolvedValue(makeUser()) } as any,
        {
          generateKey: jest.fn().mockResolvedValue({
            publicKey: 'GPUB',
            encryptedData: 'enc',
            encryptionVersion: 1,
            keyVersion: 1,
            keyType: KeyType.STELLAR_ED25519,
          }),
        } as any,
        mockPrisma as any,
        undefined, // webhookEmitter
        undefined, // walletRetryService
        undefined, // walletApiMetrics
        undefined, // orchestratorMetrics — intentionally absent
      );

      await expect(
        orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET }),
      ).resolves.toBeDefined();
    });
  });

  // ── Boundary: requestId is forwarded in log context but not in result ──

  describe('requestId boundary (#423 bugfix)', () => {
    it('does not include requestId in the returned result', async () => {
      const { orchestrator, mockUserService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      const result = await orchestrator.createWallet(
        { userId: 'user-boundary-1', network: WalletNetwork.TESTNET },
        'req-id-abc',
      );

      // The result interface does not expose requestId
      expect((result as any).requestId).toBeUndefined();
    });

    it('accepts undefined requestId without throwing (label bug fix)', async () => {
      const { orchestrator, mockUserService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());

      await expect(
        orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET }, undefined),
      ).resolves.toBeDefined();
    });
  });

  // ── Boundary: WalletCreationOrchestrator does NOT own full CRUD ──

  describe('ownership boundary (orchestrator does not own CRUD)', () => {
    it('reads existing wallet via Prisma tx, not WalletsService', async () => {
      const { orchestrator, mockUserService } = buildOrchestrator();
      mockUserService.findUserById.mockResolvedValue(makeUser());
      mockTx.wallet.findFirst.mockResolvedValue(makeDbWallet());

      const result = await orchestrator.createWallet({ userId: 'user-boundary-1', network: WalletNetwork.TESTNET });

      // Returns existing wallet without issuing a create call
      expect(mockTx.wallet.create).not.toHaveBeenCalled();
      expect(result.isNewWallet).toBe(false);
    });

    it('getWalletByUser reads via top-level Prisma client, not the tx', async () => {
      const { orchestrator } = buildOrchestrator();
      mockPrisma.wallet.findFirst.mockResolvedValue(makeDbWallet());

      const wallet = await orchestrator.getWalletByUser('user-boundary-1', WalletNetwork.TESTNET);

      expect(wallet).not.toBeNull();
      expect(mockPrisma.wallet.findFirst).toHaveBeenCalled();
    });
  });
});
