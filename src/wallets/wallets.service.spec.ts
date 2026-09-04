import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { WalletsService, CreateWalletRequest } from './wallets.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { TransactionStatus } from '../transactions/domain/transaction.model';
import {
  EncryptionService,
  DecryptionError,
} from '../encryption/encryption.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyDecryptionException } from '../key-management/exceptions/key-decryption.exception';
import { KeyType } from '../key-management/domain/key-types';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletRetryService } from './wallet-retry.service';
import { WalletApiMetricsService } from './wallet-api-metrics.service';

// Shared mock Prisma wallet methods
const mockPrismaWallet = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};

// Shared mock Prisma user methods (used by network preference lookups)
const mockPrismaUser = {
  findUnique: jest.fn(),
  update: jest.fn(),
};

// Shared mock Prisma transaction methods (used by the pending-delete guard)
const mockPrismaTransactionModel = {
  count: jest.fn(),
};

// $transaction mock – executes the callback and passes the wallet mock as the tx client
const mockPrismaTransaction = jest.fn(async (cb: (tx: any) => Promise<any>) =>
  cb({ wallet: mockPrismaWallet }),
);

// Mock the PrismaClient module so new PrismaClient() returns our mock
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: jest.fn(() => ({
    wallet: mockPrismaWallet,
    user: mockPrismaUser,
    transaction: mockPrismaTransactionModel,
    $transaction: mockPrismaTransaction,
  })),
}));

// Mock crypto sign to avoid actual key operations in tests
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    sign: jest.fn().mockReturnValue(Buffer.from('mock-signature')),
    generateKeyPairSync: jest.fn().mockReturnValue({
      publicKey: {
        export: jest.fn().mockReturnValue(Buffer.from('mock-public-key')),
      },
      privateKey: {
        export: jest.fn().mockReturnValue(Buffer.from('mock-private-key')),
      },
    }),
    createPrivateKey: jest.fn().mockReturnValue({}),
  };
});

describe('WalletsService', () => {
  let service: WalletsService;
  let encryptionService: EncryptionService;
  let keyManagementService: {
    generateKey: jest.Mock;
    sign: jest.Mock;
    validateKey: jest.Mock;
    rotateKey: jest.Mock;
  };
  let webhookEventEmitter: {
    emitWalletCreated: jest.Mock;
    emitWalletActivated: jest.Mock;
    emitWalletSuspended: jest.Mock;
    emitWalletRotated: jest.Mock;
  };
  let walletRetryService: { execute: jest.Mock };
  let walletApiMetrics: { record: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockEncryptionService = {
      validateConfiguration: jest.fn().mockReturnValue(true),
      encryptAndSerialize: jest.fn(),
      deserializeAndDecrypt: jest.fn(),
    };

    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key'),
    };

    const mockKeyManagementService = {
      generateKey: jest.fn().mockResolvedValue({
        publicKey: 'new-public-key',
        encryptedData: 'new-encrypted-secret',
        encryptionVersion: 1,
        keyVersion: 2,
        keyType: 'STELLAR_ED25519',
      }),
      sign: jest.fn(),
      validateKey: jest.fn(),
      rotateKey: jest.fn(),
    };
    webhookEventEmitter = {
      emitWalletCreated: jest.fn().mockResolvedValue(undefined),
      emitWalletActivated: jest.fn().mockResolvedValue(undefined),
      emitWalletSuspended: jest.fn().mockResolvedValue(undefined),
      emitWalletRotated: jest.fn().mockResolvedValue(undefined),
    };
    walletRetryService = {
      execute: jest.fn((_options, operation) => operation(1)),
    };
    walletApiMetrics = { record: jest.fn() };

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
          provide: KeyManagementService,
          useValue: mockKeyManagementService,
        },
        { provide: WebhookEventEmitterService, useValue: webhookEventEmitter },
        { provide: WalletRetryService, useValue: walletRetryService },
        { provide: WalletApiMetricsService, useValue: walletApiMetrics },
      ],
    }).compile();

    service = module.get<WalletsService>(WalletsService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
    keyManagementService = module.get(KeyManagementService);
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
      jest
        .spyOn(encryptionService, 'validateConfiguration')
        .mockReturnValue(false);

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
        keyVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaWallet.findFirst.mockResolvedValue(null);
      mockPrismaWallet.create.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('decrypted-private-key');

      const result = await service.createWallet(createWalletRequest);

      expect(result.wallet.id).toBe('wallet-123');
      expect(result.wallet.userId).toBe('user-123');
      expect(result.wallet.publicKey).toBe('public-key-123');
      expect(result.privateKey).toBe('decrypted-private-key');
      expect(keyManagementService.generateKey).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });
      expect(webhookEventEmitter.emitWalletCreated).toHaveBeenCalledWith({
        walletId: 'wallet-123',
        userId: 'user-123',
        publicKey: 'public-key-123',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
      });
      expect(walletApiMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'create', outcome: 'success' }),
      );
    });

    it('should throw ConflictException if user already has a wallet on the network', async () => {
      const existingWallet = {
        id: 'existing-wallet',
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      };

      mockPrismaWallet.findFirst.mockResolvedValue(existingWallet);

      await expect(service.createWallet(createWalletRequest)).rejects.toThrow(
        'User already has a wallet on TESTNET',
      );
    });

    it('should handle database errors gracefully', async () => {
      mockPrismaWallet.findFirst.mockResolvedValue(null);
      mockPrismaWallet.create.mockRejectedValue(new Error('Database error'));

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

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('private-key-123');

      const result = await service.getDecryptedPrivateKey('wallet-123');

      expect(result).toBe('private-key-123');
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalledWith(
        'encrypted-secret',
      );
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(
        service.getDecryptedPrivateKey('non-existent'),
      ).rejects.toThrow('Wallet with ID non-existent not found');
    });

    it('should throw error if wallet is not active', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'SUSPENDED',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);

      await expect(
        service.getDecryptedPrivateKey('wallet-123'),
      ).rejects.toThrow('Cannot sign with wallet in status: SUSPENDED');
    });

    it('should handle decryption errors gracefully', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      await expect(
        service.getDecryptedPrivateKey('wallet-123'),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('should surface correct reason code in KeyDecryptionException', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        encryptedSecret: 'encrypted-secret',
        status: 'ACTIVE',
      };

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Invalid key', 'INVALID_KEY');
        });

      let caught: KeyDecryptionException | undefined;
      try {
        await service.getDecryptedPrivateKey('wallet-123');
      } catch (e) {
        caught = e as KeyDecryptionException;
      }

      expect(caught).toBeInstanceOf(KeyDecryptionException);
      expect(caught!.reason).toBe('INVALID_KEY');
      expect(caught!.getStatus()).toBe(422);
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

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('private-key-123');

      const result = await service.signTransaction(
        'wallet-123',
        'transaction-data',
      );

      expect(result.signature).toBeDefined();
      expect(encryptionService.deserializeAndDecrypt).toHaveBeenCalled();
    });

    it('should handle signing errors gracefully', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(
        service.signTransaction('wallet-123', 'transaction-data'),
      ).rejects.toThrow('Transaction signing failed');
    });
  });

  describe('rotateWalletKey (#692 successor model)', () => {
    const predecessorRecord = {
      id: 'wallet-123',
      userId: 'user-123',
      publicKey: 'old-public-key',
      encryptedSecret: 'old-encrypted-secret',
      secretVersion: 1,
      keyVersion: 1,
      network: WalletNetwork.TESTNET,
      status: 'ROTATING',
      encryptionVersion: 1,
      statusReason: 'Key rotation initiated',
      statusChangedAt: new Date(),
      rotatedFromId: null,
      successorId: 'wallet-456',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const successorRecord = {
      id: 'wallet-456',
      userId: 'user-123',
      publicKey: 'new-public-key',
      encryptedSecret: 'new-encrypted-secret',
      secretVersion: 2,
      keyVersion: 1,
      network: WalletNetwork.TESTNET,
      status: 'ACTIVE',
      encryptionVersion: 1,
      statusReason: null,
      statusChangedAt: new Date(),
      rotatedFromId: 'wallet-123',
      successorId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('delegates to KeyManagementService.rotateKey and returns predecessor + successor', async () => {
      mockPrismaWallet.findUnique.mockImplementation(
        ({ where: { id } }: { where: { id: string } }) => {
          if (id === 'wallet-123') return Promise.resolve(predecessorRecord);
          if (id === 'wallet-456') return Promise.resolve(successorRecord);
          return Promise.resolve(null);
        },
      );
      keyManagementService.rotateKey.mockResolvedValue({
        predecessorWalletId: 'wallet-123',
        successorWalletId: 'wallet-456',
        successorPublicKey: 'new-public-key',
        successorKeyVersion: 1,
      });

      const result = await service.rotateWalletKey('wallet-123');

      expect(keyManagementService.rotateKey).toHaveBeenCalledWith('wallet-123');
      expect(keyManagementService.generateKey).not.toHaveBeenCalled();
      expect(mockPrismaWallet.update).not.toHaveBeenCalled();
      expect(result.successor.id).toBe('wallet-456');
      expect(result.successor.publicKey).toBe('new-public-key');
      expect(result.predecessor.id).toBe('wallet-123');
      expect(result.predecessor.status).toBe('ROTATING');
      // Key material is never returned
      expect(result.successor).not.toHaveProperty('encryptedSecret');
      expect(result as unknown as Record<string, unknown>).not.toHaveProperty(
        'privateKey',
      );
      expect(webhookEventEmitter.emitWalletRotated).toHaveBeenCalledWith({
        walletId: 'wallet-456',
        userId: 'user-123',
        publicKey: 'new-public-key',
        network: WalletNetwork.TESTNET,
        secretVersion: 2,
      });
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.rotateWalletKey('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
      expect(keyManagementService.rotateKey).not.toHaveBeenCalled();
    });
  });

  // #185: Wallet Status Endpoint
  describe('getWalletStatus', () => {
    it('should return wallet status', async () => {
      const mockWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
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

      mockPrismaWallet.findUnique.mockResolvedValue(mockWallet);

      const result = await service.getWalletStatus('wallet-123');

      expect(result.id).toBe('wallet-123');
      expect(result.status).toBe('ACTIVE');
      expect(result.network).toBe(WalletNetwork.TESTNET);
      expect(result.publicKey).toBe('GABC123');
      expect(mockPrismaWallet.findUnique).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
      });
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.getWalletStatus('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });
  });

  describe('updateWalletStatus', () => {
    it('emits wallet.suspended only after the status update is persisted', async () => {
      const suspendedWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
        encryptionVersion: 1,
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: WalletStatus.SUSPENDED,
        statusReason: 'manual review',
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrismaWallet.findUnique.mockResolvedValue({
        ...suspendedWallet,
        status: WalletStatus.ACTIVE,
      });
      mockPrismaWallet.update.mockResolvedValue(suspendedWallet);

      await service.updateWalletStatus(
        'wallet-123',
        WalletStatus.SUSPENDED,
        'manual review',
      );

      expect(webhookEventEmitter.emitWalletSuspended).toHaveBeenCalledWith({
        walletId: 'wallet-123',
        userId: 'user-123',
        reason: 'manual review',
      });
      expect(walletApiMetrics.record).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'status_update',
          outcome: 'success',
        }),
      );
    });
  });

  // Network immutability: wallet network cannot be changed after creation
  describe('network immutability', () => {
    it('should reject update when network is provided in the DTO', () => {
      expect(() =>
        service.update('wallet-123', {
          status: 'ACTIVE',
          network: WalletNetwork.MAINNET,
        }),
      ).toThrow(
        'Wallet network is immutable after creation and cannot be changed.',
      );
    });

    it('should allow update when only status is provided (no network)', async () => {
      const wallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
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

      mockPrismaWallet.findUnique.mockResolvedValue(wallet);
      mockPrismaWallet.update.mockResolvedValue({
        ...wallet,
        status: 'SUSPENDED',
      });

      const result = await service.update('wallet-123', {
        status: 'SUSPENDED',
      });

      expect(result).toBeDefined();
      expect(mockPrismaWallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
        data: expect.objectContaining({ status: 'SUSPENDED' }),
      });
    });
  });

  // #188: Activate Wallet (PROVISIONING -> ACTIVE)
  describe('activateWallet', () => {
    it('should transition PROVISIONING to ACTIVE', async () => {
      const provisioningWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
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

      mockPrismaWallet.findUnique.mockResolvedValue(provisioningWallet);
      mockPrismaWallet.update.mockResolvedValue(activeWallet);

      const result = await service.activateWallet('wallet-123');

      expect(result.status).toBe('ACTIVE');
      expect(mockPrismaWallet.update).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
        data: expect.objectContaining({
          status: 'ACTIVE',
          statusReason: 'Wallet provisioned and activated',
        }),
      });
      expect(webhookEventEmitter.emitWalletActivated).toHaveBeenCalledWith({
        walletId: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
      });
    });

    it('should throw error if wallet is not in PROVISIONING status', async () => {
      const activeWallet = {
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'GABC123',
        encryptedSecret: 'secret',
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

      mockPrismaWallet.findUnique.mockResolvedValue(activeWallet);

      await expect(service.activateWallet('wallet-123')).rejects.toThrow(
        'Cannot activate wallet in status: ACTIVE',
      );
    });

    it('should throw NotFoundException if wallet not found', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.activateWallet('non-existent')).rejects.toThrow(
        'Wallet with ID non-existent not found',
      );
    });
  });

  // #189: Find wallets by userId
  describe('findWalletsByUserId', () => {
    it('should return all wallets for a userId', async () => {
      const wallets = [
        {
          id: 'wallet-1',
          userId: 'user-123',
          publicKey: 'GABC1',
          encryptedSecret: 'secret1',
          encryptionVersion: 1,
          secretVersion: 1,
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'wallet-2',
          userId: 'user-123',
          publicKey: 'GABC2',
          encryptedSecret: 'secret2',
          encryptionVersion: 1,
          secretVersion: 1,
          network: WalletNetwork.MAINNET,
          status: 'ACTIVE',
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaWallet.findMany.mockResolvedValue(wallets);

      const result = await service.findWalletsByUserId('user-123');

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user-123');
      expect(result[1].userId).toBe('user-123');
      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('should return empty array if user has no wallets', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);

      const result = await service.findWalletsByUserId('user-no-wallets');

      expect(result).toEqual([]);
    });
  });

  // #325 / #326: pagination + filtering on the wallet list endpoint
  describe('findAll', () => {
    const walletRow = {
      id: 'wallet-1',
      userId: 'user-123',
      publicKey: 'GABC1',
      encryptedSecret: 'secret1',
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

    it('defaults to limit=20 and offset=0 with no filters (excludes ARCHIVED by default)', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([walletRow]);
      mockPrismaWallet.count.mockResolvedValue(1);

      const result = await service.findAll();

      // #496: archived wallets are excluded by default
      const expectedWhere = { status: { not: WalletStatus.ARCHIVED } };
      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith({
        where: expectedWhere,
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: 0,
      });
      expect(mockPrismaWallet.count).toHaveBeenCalledWith({ where: expectedWhere });
      expect(result).toEqual({
        data: [expect.objectContaining({ id: 'wallet-1' })],
        total: 1,
        limit: 20,
        offset: 0,
        hasMore: false,
      });
    });

    it('applies network, status, and userId filters', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll({
        userId: 'user-123',
        network: WalletNetwork.MAINNET,
        status: WalletStatus.ACTIVE,
      });

      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-123',
          network: WalletNetwork.MAINNET,
          status: WalletStatus.ACTIVE,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        skip: 0,
      });
    });

    it('passes a custom limit and offset through to Prisma', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([]);
      mockPrismaWallet.count.mockResolvedValue(0);

      await service.findAll({ limit: 5, offset: 10 });

      expect(mockPrismaWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5, skip: 10 }),
      );
    });

    it('sets hasMore=true when more records remain after this page', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([walletRow]);
      mockPrismaWallet.count.mockResolvedValue(5);

      const result = await service.findAll({ limit: 1, offset: 0 });

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(5);
    });

    it('sets hasMore=false on the last page', async () => {
      mockPrismaWallet.findMany.mockResolvedValue([walletRow]);
      mockPrismaWallet.count.mockResolvedValue(5);

      const result = await service.findAll({ limit: 20, offset: 4 });

      expect(result.hasMore).toBe(false);
    });

    // #696: loadTestMode must be gated to non-production environments
    describe('loadTestMode gating (#696)', () => {
      const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
      afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
      });

      it('returns synthetic data outside production', async () => {
        process.env.NODE_ENV = 'development';

        const result = await service.findAll({ loadTestMode: true, limit: 3 });

        expect(result.data).toHaveLength(3);
        expect(result.total).toBe(1000);
        expect(mockPrismaWallet.findMany).not.toHaveBeenCalled();
      });

      it('rejects loadTestMode with 403 in production', async () => {
        process.env.NODE_ENV = 'production';

        await expect(
          service.findAll({ loadTestMode: true }),
        ).rejects.toMatchObject({ status: 403 });
        expect(mockPrismaWallet.findMany).not.toHaveBeenCalled();
      });

      it('still serves real data in production when loadTestMode is not set', async () => {
        process.env.NODE_ENV = 'production';
        mockPrismaWallet.findMany.mockResolvedValue([walletRow]);
        mockPrismaWallet.count.mockResolvedValue(1);

        const result = await service.findAll({});

        expect(result.total).toBe(1);
        expect(mockPrismaWallet.findMany).toHaveBeenCalled();
      });
    });
  });

  describe('getNetworkPreference', () => {
    it('returns the persisted preference for an existing user', async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: 'user-1',
        defaultNetwork: 'TESTNET',
      });

      const result = await service.getNetworkPreference('user-1');

      expect(mockPrismaUser.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
      });
      expect(result).toEqual({
        userId: 'user-1',
        defaultNetwork: WalletNetwork.TESTNET,
      });
    });

    it('returns null defaultNetwork when the user has no preference set', async () => {
      mockPrismaUser.findUnique.mockResolvedValue({
        id: 'user-1',
        defaultNetwork: null,
      });

      const result = await service.getNetworkPreference('user-1');

      expect(result).toEqual({ userId: 'user-1', defaultNetwork: null });
    });

    it('throws NotFoundException when the user does not exist', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);

      await expect(
        service.getNetworkPreference('missing-user'),
      ).rejects.toThrow('User with ID missing-user not found');
    });
  });

  describe('setNetworkPreference', () => {
    it('persists the network preference for an existing user', async () => {
      mockPrismaUser.findUnique.mockResolvedValue({ id: 'user-1' });
      mockPrismaUser.update.mockResolvedValue({
        id: 'user-1',
        defaultNetwork: 'MAINNET',
      });

      const result = await service.setNetworkPreference(
        'user-1',
        WalletNetwork.MAINNET,
      );

      expect(mockPrismaUser.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { defaultNetwork: WalletNetwork.MAINNET },
      });
      expect(result).toEqual({
        userId: 'user-1',
        defaultNetwork: WalletNetwork.MAINNET,
      });
    });

    it('throws NotFoundException when the user does not exist', async () => {
      mockPrismaUser.findUnique.mockResolvedValue(null);

      await expect(
        service.setNetworkPreference('missing-user', WalletNetwork.MAINNET),
      ).rejects.toThrow('User with ID missing-user not found');

      expect(mockPrismaUser.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    const existingWallet = {
      id: 'wallet-123',
      userId: 'user-123',
      publicKey: 'GABC123',
      encryptedSecret: 'secret',
      encryptionVersion: 1,
      secretVersion: 1,
      keyVersion: 1,
      network: WalletNetwork.TESTNET,
      status: 'ACTIVE',
      statusReason: null,
      statusChangedAt: new Date(),
      rotatedFromId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    it('deletes the wallet when there are no pending transactions', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(existingWallet);
      mockPrismaTransactionModel.count.mockResolvedValue(0);
      mockPrismaWallet.delete.mockResolvedValue(existingWallet);

      const result = await service.remove('wallet-123');

      expect(mockPrismaTransactionModel.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { senderWalletId: 'wallet-123' },
            { receiverWalletId: 'wallet-123' },
          ],
          status: {
            in: [TransactionStatus.PENDING, TransactionStatus.SUBMITTED],
          },
        },
      });
      expect(mockPrismaWallet.delete).toHaveBeenCalledWith({
        where: { id: 'wallet-123' },
      });
      expect(result.id).toBe('wallet-123');
      expect(result).not.toHaveProperty('encryptedSecret');
    });

    it('blocks deletion with a ConflictException when pending transactions exist', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(existingWallet);
      mockPrismaTransactionModel.count.mockResolvedValue(2);

      await expect(service.remove('wallet-123')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.remove('wallet-123')).rejects.toThrow(
        'Cannot delete wallet wallet-123: 2 pending transaction(s) must settle first',
      );

      expect(mockPrismaWallet.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if the wallet does not exist', async () => {
      mockPrismaWallet.findUnique.mockResolvedValue(null);

      await expect(service.remove('missing-wallet')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove('missing-wallet')).rejects.toThrow(
        'Wallet with ID missing-wallet not found',
      );

      expect(mockPrismaTransactionModel.count).not.toHaveBeenCalled();
      expect(mockPrismaWallet.delete).not.toHaveBeenCalled();
    });
  });
});
