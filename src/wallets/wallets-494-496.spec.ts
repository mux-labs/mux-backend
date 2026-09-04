/**
 * Tests for:
 *   #494 – Roll back wallet create on Horizon failure
 *   #496 – Paginate wallet list endpoints
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  WalletsService,
  CreateWalletRequest,
  WalletListFilters,
} from './wallets.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletRetryService } from './wallet-retry.service';
import { WalletApiMetricsService } from './wallet-api-metrics.service';

// ─── Prisma mock ────────────────────────────────────────────────────────────

const mockPrismaWallet = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};

const mockPrismaUser = {
  findUnique: jest.fn(),
  update: jest.fn(),
};

// $transaction passes a callback and executes it
const mockPrismaTransaction = jest.fn(async (cb: (tx: any) => Promise<any>) =>
  cb({ wallet: mockPrismaWallet }),
);

jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    wallet: mockPrismaWallet,
    user: mockPrismaUser,
    $transaction: mockPrismaTransaction,
  })),
}));

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    sign: jest.fn().mockReturnValue(Buffer.from('mock-signature')),
    createPrivateKey: jest.fn().mockReturnValue({}),
  };
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const buildWallet = (overrides: Partial<any> = {}) => ({
  id: 'wallet-123',
  userId: 'user-123',
  publicKey: 'G_PUBLIC_KEY',
  encryptedSecret: 'encrypted-secret',
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  encryptionVersion: 1,
  secretVersion: 1,
  keyVersion: 1,
  statusReason: null,
  statusChangedAt: new Date(),
  rotatedFromId: null,
  successorId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('WalletsService – #494 Rollback & #496 Pagination', () => {
  let service: WalletsService;
  let encryptionService: jest.Mocked<Pick<EncryptionService, 'validateConfiguration' | 'deserializeAndDecrypt'>>;
  let keyManagementService: { generateKey: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    encryptionService = {
      validateConfiguration: jest.fn().mockReturnValue(true),
      deserializeAndDecrypt: jest.fn().mockReturnValue('raw-private-key'),
    };

    keyManagementService = {
      generateKey: jest.fn().mockResolvedValue({
        publicKey: 'G_PUBLIC_KEY',
        encryptedData: 'encrypted-secret',
        encryptionVersion: 1,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        { provide: EncryptionService, useValue: encryptionService },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('key') } },
        { provide: KeyManagementService, useValue: keyManagementService },
        {
          provide: WebhookEventEmitterService,
          useValue: {
            emitWalletCreated: jest.fn().mockResolvedValue(undefined),
            emitWalletActivated: jest.fn().mockResolvedValue(undefined),
            emitWalletSuspended: jest.fn().mockResolvedValue(undefined),
            emitWalletRotated: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WalletRetryService,
          useValue: { execute: jest.fn((_opts, fn) => fn()) },
        },
        { provide: WalletApiMetricsService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);
  });

  // ── #494: Rollback ────────────────────────────────────────────────────────

  describe('#494 – createWallet rollback', () => {
    const req: CreateWalletRequest = {
      userId: 'user-123',
      network: WalletNetwork.TESTNET,
    };

    it('creates a wallet successfully on the happy path', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(null); // no existing wallet
      mockPrismaWallet.create.mockResolvedValue(buildWallet());

      const result = await service.createWallet(req);

      expect(result.wallet.id).toBe('wallet-123');
      expect(result.privateKey).toBe('raw-private-key');
      expect(mockPrismaTransaction).toHaveBeenCalled();
    });

    it('throws ConflictException when wallet already exists', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(buildWallet()); // duplicate

      await expect(service.createWallet(req)).rejects.toThrow(ConflictException);
      // DB transaction must NOT be called for duplicate check
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });

    it('rolls back (throws) when key generation fails', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(null);
      keyManagementService.generateKey.mockRejectedValue(new Error('HSM unavailable'));

      await expect(service.createWallet(req)).rejects.toThrow('Wallet creation failed');
      // DB $transaction must NOT be called because key-gen failed before it
      expect(mockPrismaTransaction).not.toHaveBeenCalled();
    });

    it('rolls back (throws) when DB write inside $transaction fails', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(null);
      // Simulate Prisma $transaction rolling back by throwing from inside the callback
      mockPrismaTransaction.mockImplementationOnce(async () => {
        throw new Error('DB connection lost');
      });

      await expect(service.createWallet(req)).rejects.toThrow('Wallet creation failed');
    });

    it('does NOT expose the private key in the error when creation fails', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(null);
      mockPrismaTransaction.mockImplementationOnce(async () => {
        throw new Error('DB error');
      });

      try {
        await service.createWallet(req);
      } catch (err: any) {
        expect(err.message).not.toContain('raw-private-key');
      }
    });
  });

  // ── #496: Pagination ─────────────────────────────────────────────────────

  describe('#496 – findAll pagination', () => {
    const wallets = Array.from({ length: 5 }, (_, i) =>
      buildWallet({ id: `w-${i}`, userId: `u-${i}` }),
    );

    it('returns paginated results with correct metadata', async () => {
      mockPrismaWallet.findMany.mockResolvedValue(wallets);
      mockPrismaWallet.count.mockResolvedValue(50);

      const result = await service.findAll({ limit: 5, offset: 0 });

      expect(result.data).toHaveLength(5);
      expect(result.total).toBe(50);
      expect(result.limit).toBe(5);
      expect(result.offset).toBe(0);
      expect(result.hasMore).toBe(true);
    });

    it('hasMore is false when on the last page', async () => {
      mockPrismaWallet.findMany.mockResolvedValue(wallets.slice(0, 3));
      mockPrismaWallet.count.mockResolvedValue(8);

      const result = await service.findAll({ limit: 5, offset: 5 });

      // 5 + 3 = 8 = total → no more
      expect(result.hasMore).toBe(false);
    });

    it('uses default limit=20 and offset=0 when not provided', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      const result = await service.findAll();

      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 0 }),
      );
    });

    it('caps limit at 100', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      const result = await service.findAll({ limit: 500 });

      expect(result.limit).toBe(100);
      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });

    it('filters by userId', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll({ userId: 'user-abc' });

      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: 'user-abc' }) }),
      );
    });

    it('filters by network', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll({ network: WalletNetwork.MAINNET });

      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ network: WalletNetwork.MAINNET }) }),
      );
    });

    it('filters by status', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll({ status: WalletStatus.SUSPENDED });

      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: WalletStatus.SUSPENDED }) }),
      );
    });

    it('excludes archived wallets by default', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll();

      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { not: WalletStatus.ARCHIVED },
          }),
        }),
      );
    });

    it('includes archived wallets when includeArchived=true', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll({ includeArchived: true });

      const call = mockPrismaWallet.findMany.mock.calls[0][0];
      // status filter should NOT be set when includeArchived=true and no explicit status given
      expect(call.where).not.toHaveProperty('status');
    });

    it('does not expose encryptedSecret in returned wallets', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([buildWallet()]);
      mockPrismaWallet.count.mockResolvedValue(1);

      const result = await service.findAll();

      result.data.forEach((w) => {
        expect((w as any).encryptedSecret).toBeUndefined();
      });
    });

    it('returns synthetic data in loadTestMode', async () => {
      const result = await service.findAll({ loadTestMode: true, limit: 10, offset: 0 });

      expect(result.data).toHaveLength(10);
      expect(result.total).toBe(1000);
      // Prisma must NOT be called in load-test mode
      expect(mockPrismaWallet.findMany).not.toHaveBeenCalled();
    });
  });
});
