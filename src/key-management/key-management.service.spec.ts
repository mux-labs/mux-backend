import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KeyManagementService } from './key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyType } from './domain/key-types';

describe('KeyManagementService', () => {
  let service: KeyManagementService;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
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
      // Generate a key first
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Sign some data
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

      // Check that no log contains anything that looks like a private key
      const allLogs = [...logSpy.mock.calls, ...errorSpy.mock.calls];
      const logsAsString = JSON.stringify(allLogs);

      // Should not contain common private key patterns
      expect(logsAsString).not.toMatch(/privateKey/i);
      expect(logsAsString).not.toMatch(/secret.*seed/i);
    });
  });
});
