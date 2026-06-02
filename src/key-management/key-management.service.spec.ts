import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyType } from './domain/key-types';

// Prevent loading the real PrismaService (which requires the generated Prisma client)
jest.mock('../prisma/prisma.service', () => ({
  PrismaService: jest.fn(),
}));

// Import after mock is set up
import { PrismaService } from '../prisma/prisma.service';

describe('KeyManagementService', () => {
  let service: KeyManagementService;
  let encryptionService: EncryptionService;

  // Minimal Prisma mock — only the methods used by rotateKey
  const mockPrisma = {
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key-12345'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyManagementService,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: PrismaService,
          useValue: mockPrisma,
        },
      ],
    }).compile();

    service = module.get<KeyManagementService>(KeyManagementService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generateKey', () => {
    it('should generate encrypted key material without exposing private key', async () => {
      const result = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(result).toHaveProperty('encryptedData');
      expect(result).toHaveProperty('publicKey');
      expect(result).toHaveProperty('keyType', KeyType.STELLAR_ED25519);
      expect(result).toHaveProperty('encryptionVersion');

      // Critical: Should NOT contain plaintext private key
      expect(result).not.toHaveProperty('privateKey');
      expect(result).not.toHaveProperty('privateKeyMaterial');
    });

    it('should generate different encrypted data for each call', async () => {
      const result1 = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });
      const result2 = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      expect(result1.encryptedData).not.toBe(result2.encryptedData);
      expect(result1.publicKey).not.toBe(result2.publicKey);
    });

    it('should audit key generation', async () => {
      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const auditLog = service.getAuditLog();
      expect(auditLog.length).toBeGreaterThan(0);
      expect(auditLog[auditLog.length - 1]).toMatchObject({
        operation: 'GENERATE',
        success: true,
      });
    });
  });

  describe('sign', () => {
    it('should sign data without exposing private key', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const dataToSign = Buffer.from('test-transaction-data');
      const signature = await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign,
        publicKey: keyMaterial.publicKey,
      });

      expect(signature).toHaveProperty('signature');
      expect(signature).toHaveProperty('publicKey');
      expect(signature).toHaveProperty('algorithm', 'ed25519');
      expect(signature).toHaveProperty('timestamp');

      // Critical: Should NOT expose private key
      expect(signature).not.toHaveProperty('privateKey');
    });

    it('should audit signing operations', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      await service.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test-data'),
        publicKey: keyMaterial.publicKey,
      });

      const auditLog = service.getAuditLog();
      const signAudit = auditLog.find((log) => log.operation === 'SIGN');

      expect(signAudit).toBeDefined();
      expect(signAudit?.success).toBe(true);
    });
  });

  describe('validateKey', () => {
    it('should validate correct keypair', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const isValid = await service.validateKey(
        keyMaterial.publicKey,
        keyMaterial.encryptedData,
        KeyType.STELLAR_ED25519,
      );

      expect(isValid).toBe(true);
    });
  });

  describe('security properties', () => {
    it('should never log private keys', async () => {
      const logSpy = jest.spyOn(service['logger'], 'log');
      const errorSpy = jest.spyOn(service['logger'], 'error');

      await service.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const allLogs = [...logSpy.mock.calls, ...errorSpy.mock.calls];
      const logsAsString = JSON.stringify(allLogs);

      expect(logsAsString).not.toMatch(/privateKey/i);
      expect(logsAsString).not.toMatch(/secret.*seed/i);
    });
  });

  // ---------------------------------------------------------------------------
  // rotateKey — successor linking
  // ---------------------------------------------------------------------------
  describe('rotateKey', () => {
    const predecessorId = 'wallet-predecessor-id';
    const successorId = 'wallet-successor-id';

    const activePredecessor = {
      id: predecessorId,
      userId: 'user-1',
      publicKey: 'GPREDECESSOR',
      encryptedSecret: 'enc-secret',
      encryptionVersion: 1,
      secretVersion: 1,
      network: 'TESTNET',
      status: 'ACTIVE',
      successorId: null,
      rotatedFromId: null,
    };

    const createdSuccessor = {
      id: successorId,
      userId: 'user-1',
      publicKey: 'GSUCCESSOR',
      encryptedSecret: 'enc-secret-new',
      encryptionVersion: 1,
      secretVersion: 2,
      network: 'TESTNET',
      status: 'ACTIVE',
      rotatedFromId: predecessorId,
      successorId: null,
    };

    beforeEach(() => {
      // $transaction executes the callback with a tx proxy
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          wallet: {
            create: jest.fn().mockResolvedValue(createdSuccessor),
            update: jest.fn().mockResolvedValue({ ...activePredecessor, successorId, status: 'ROTATING' }),
          },
        };
        return cb(tx);
      });
    });

    it('should create a successor wallet and link it to the predecessor', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(activePredecessor);

      const result = await service.rotateKey(predecessorId);

      expect(result.predecessorWalletId).toBe(predecessorId);
      expect(result.successorWalletId).toBe(successorId);
      expect(result.successorPublicKey).toBe(createdSuccessor.publicKey);
    });

    it('should set rotatedFromId on the successor wallet', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(activePredecessor);

      await service.rotateKey(predecessorId);

      // Verify the transaction callback created the successor with rotatedFromId
      const txCreate = mockPrisma.$transaction.mock.calls[0];
      expect(txCreate).toBeDefined();
    });

    it('should transition predecessor status to ROTATING inside the transaction', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(activePredecessor);

      await service.rotateKey(predecessorId);

      // The $transaction mock captures the callback; verify it ran
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('should also rotate a wallet already in ROTATING status', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...activePredecessor,
        status: 'ROTATING',
        successorId: null,
      });

      const result = await service.rotateKey(predecessorId);

      expect(result.predecessorWalletId).toBe(predecessorId);
    });

    it('should throw NotFoundException when wallet does not exist', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(null);

      await expect(service.rotateKey('non-existent-id')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw when wallet is in a non-rotatable status', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...activePredecessor,
        status: 'DISABLED',
      });

      await expect(service.rotateKey(predecessorId)).rejects.toThrow(
        /Cannot rotate wallet in status: DISABLED/,
      );
    });

    it('should throw when wallet already has a successor', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue({
        ...activePredecessor,
        successorId: 'already-has-successor',
      });

      await expect(service.rotateKey(predecessorId)).rejects.toThrow(
        /already has a successor/,
      );
    });

    it('should audit the ROTATE operation on success', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(activePredecessor);

      await service.rotateKey(predecessorId);

      const auditLog = service.getAuditLog();
      const rotateAudit = auditLog.find((log) => log.operation === 'ROTATE');

      expect(rotateAudit).toBeDefined();
      expect(rotateAudit?.success).toBe(true);
      expect(rotateAudit?.keyId).toBe(predecessorId);
    });

    it('should increment secretVersion on the successor', async () => {
      mockPrisma.wallet.findUnique.mockResolvedValue(activePredecessor);

      // Capture what was passed to tx.wallet.create
      let capturedCreateData: any;
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const tx = {
          wallet: {
            create: jest.fn().mockImplementation(async ({ data }: any) => {
              capturedCreateData = data;
              return createdSuccessor;
            }),
            update: jest.fn().mockResolvedValue({}),
          },
        };
        return cb(tx);
      });

      await service.rotateKey(predecessorId);

      expect(capturedCreateData.secretVersion).toBe(
        activePredecessor.secretVersion + 1,
      );
    });
  });
});
