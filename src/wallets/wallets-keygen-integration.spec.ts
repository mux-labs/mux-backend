import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalletsService } from './wallets.service';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { KeyManagementService } from '../key-management/key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { WalletNetwork } from './domain/wallet.model';
import { KeyType } from '../key-management/domain/key-types';
import { PrismaClient } from '../generated/prisma/client';
import { IdempotentUserService } from '../users/idempotent-user.service';

/**
 * Integration test to verify that WalletsService and WalletCreationOrchestrator
 * are properly using the consolidated KeyManagementService for key generation.
 */
describe('Wallets KeyGen Integration', () => {
  let walletsService: WalletsService;
  let walletCreationOrchestrator: WalletCreationOrchestrator;
  let keyManagementService: KeyManagementService;
  let encryptionService: EncryptionService;

  const mockPrisma = {
    wallet: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockIdempotentUserService = {
    findUserById: jest.fn(),
    createUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        WalletCreationOrchestrator,
        KeyManagementService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue('test-encryption-key-32-chars!!'),
          },
        },
        {
          provide: PrismaClient,
          useValue: mockPrisma,
        },
        {
          provide: IdempotentUserService,
          useValue: mockIdempotentUserService,
        },
      ],
    }).compile();

    walletsService = module.get<WalletsService>(WalletsService);
    walletCreationOrchestrator = module.get<WalletCreationOrchestrator>(
      WalletCreationOrchestrator,
    );
    keyManagementService = module.get<KeyManagementService>(
      KeyManagementService,
    );
    encryptionService = module.get<EncryptionService>(EncryptionService);

    // Setup common mocks
    jest.clearAllMocks();
  });

  describe('WalletsService - KeyManagementService Integration', () => {
    it('should use KeyManagementService to generate keys during wallet creation', async () => {
      const generateKeySpy = jest.spyOn(keyManagementService, 'generateKey');

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue({
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'generated-public-key',
        encryptedSecret: 'encrypted-data',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await walletsService.createWallet({
        userId: 'user-123',
        network: WalletNetwork.TESTNET,
      });

      // Verify KeyManagementService.generateKey was called
      expect(generateKeySpy).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-123', network: WalletNetwork.TESTNET },
      });

      // Verify it was called exactly once
      expect(generateKeySpy).toHaveBeenCalledTimes(1);
    });

    it('should use KeyManagementService during wallet key rotation', async () => {
      const generateKeySpy = jest.spyOn(keyManagementService, 'generateKey');

      mockPrisma.wallet.findUnique.mockResolvedValue({
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'old-public-key',
        encryptedSecret: 'old-encrypted-secret',
        secretVersion: 1,
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma.wallet.update.mockResolvedValue({
        id: 'wallet-123',
        userId: 'user-123',
        publicKey: 'new-public-key',
        encryptedSecret: 'new-encrypted-secret',
        secretVersion: 2,
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await walletsService.rotateWalletKey('wallet-123');

      // Verify KeyManagementService.generateKey was called
      expect(generateKeySpy).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { walletId: 'wallet-123', operation: 'rotation' },
      });
    });
  });

  describe('WalletCreationOrchestrator - KeyManagementService Integration', () => {
    it('should use KeyManagementService to generate keys during orchestrated wallet creation', async () => {
      const generateKeySpy = jest.spyOn(keyManagementService, 'generateKey');

      mockIdempotentUserService.findUserById.mockResolvedValue({
        id: 'user-123',
        authId: 'auth-123',
        status: 'ACTIVE',
        authProvider: 'email',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma.$transaction.mockImplementation(async (callback) => {
        return callback(mockPrisma as any);
      });

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue({
        id: 'wallet-456',
        userId: 'user-123',
        publicKey: 'generated-public-key',
        encryptedSecret: 'encrypted-data',
        network: WalletNetwork.MAINNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await walletCreationOrchestrator.createWallet({
        userId: 'user-123',
        network: WalletNetwork.MAINNET,
      });

      // Verify KeyManagementService.generateKey was called
      expect(generateKeySpy).toHaveBeenCalledWith({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-123', network: WalletNetwork.MAINNET },
      });

      // Verify it was called exactly once
      expect(generateKeySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Key Generation Consistency', () => {
    it('should generate different keys for multiple wallets', async () => {
      const generateKeySpy = jest.spyOn(keyManagementService, 'generateKey');

      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create
        .mockResolvedValueOnce({
          id: 'wallet-1',
          userId: 'user-1',
          publicKey: 'public-key-1',
          encryptedSecret: 'encrypted-1',
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
          encryptionVersion: 1,
          secretVersion: 1,
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: 'wallet-2',
          userId: 'user-2',
          publicKey: 'public-key-2',
          encryptedSecret: 'encrypted-2',
          network: WalletNetwork.TESTNET,
          status: 'ACTIVE',
          encryptionVersion: 1,
          secretVersion: 1,
          statusReason: null,
          statusChangedAt: new Date(),
          rotatedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

      await walletsService.createWallet({
        userId: 'user-1',
        network: WalletNetwork.TESTNET,
      });

      await walletsService.createWallet({
        userId: 'user-2',
        network: WalletNetwork.TESTNET,
      });

      // Should call generateKey twice with different metadata
      expect(generateKeySpy).toHaveBeenCalledTimes(2);
      expect(generateKeySpy).toHaveBeenNthCalledWith(1, {
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-1', network: WalletNetwork.TESTNET },
      });
      expect(generateKeySpy).toHaveBeenNthCalledWith(2, {
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'user-2', network: WalletNetwork.TESTNET },
      });
    });
  });

  describe('Audit Trail Integration', () => {
    it('should create audit logs when generating keys through WalletsService', async () => {
      mockPrisma.wallet.findFirst.mockResolvedValue(null);
      mockPrisma.wallet.create.mockResolvedValue({
        id: 'wallet-audit',
        userId: 'user-audit',
        publicKey: 'public-key-audit',
        encryptedSecret: 'encrypted-audit',
        network: WalletNetwork.TESTNET,
        status: 'ACTIVE',
        encryptionVersion: 1,
        secretVersion: 1,
        statusReason: null,
        statusChangedAt: new Date(),
        rotatedFromId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await walletsService.createWallet({
        userId: 'user-audit',
        network: WalletNetwork.TESTNET,
      });

      // Check audit log
      const auditLog = keyManagementService.getAuditLog();
      expect(auditLog.length).toBeGreaterThan(0);

      const lastAudit = auditLog[auditLog.length - 1];
      expect(lastAudit.operation).toBe('GENERATE');
      expect(lastAudit.success).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle key generation failures gracefully', async () => {
      // Force KeyManagementService to throw an error
      jest
        .spyOn(keyManagementService, 'generateKey')
        .mockRejectedValue(new Error('Key generation failed'));

      mockPrisma.wallet.findFirst.mockResolvedValue(null);

      await expect(
        walletsService.createWallet({
          userId: 'user-error',
          network: WalletNetwork.TESTNET,
        }),
      ).rejects.toThrow('Wallet creation failed');

      // Verify database create was not called due to early failure
      expect(mockPrisma.wallet.create).not.toHaveBeenCalled();
    });
  });
});
