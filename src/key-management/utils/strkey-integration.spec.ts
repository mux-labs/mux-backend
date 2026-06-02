import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KeyManagementService } from '../key-management.service';
import { EncryptionService } from '../../encryption/encryption.service';
import { KeyType } from '../domain/key-types';
import { StrKeyHelper } from './strkey.helper';
import { Keypair } from 'stellar-sdk';

describe('StrKeyHelper Integration with Key Management', () => {
  let keyManagementService: KeyManagementService;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key-32-bytes-long!'),
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

    keyManagementService = module.get<KeyManagementService>(KeyManagementService);
    encryptionService = module.get<EncryptionService>(EncryptionService);
  });

  describe('Key Generation and Validation', () => {
    it('should generate keys that pass StrKey validation', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { test: 'integration' },
      });

      // The public key should be a valid Stellar StrKey format
      expect(StrKeyHelper.isValidEd25519PublicKey(keyMaterial.publicKey)).toBe(true);
      expect(keyMaterial.publicKey.startsWith('G')).toBe(true);
      expect(keyMaterial.publicKey.length).toBe(56);

      // Should identify as public key type
      const keyType = StrKeyHelper.getStrKeyType(keyMaterial.publicKey);
      expect(keyType.isValid).toBe(true);
      expect(keyType.type).toBe('publicKey');
    });

    it('should decrypt and validate secret seed format', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Decrypt the secret (this would normally never be done, but for testing)
      const decryptedSecret = encryptionService.deserializeAndDecrypt(
        keyMaterial.encryptedData,
      );

      // The decrypted secret should be a valid Stellar secret seed
      expect(StrKeyHelper.isValidEd25519SecretSeed(decryptedSecret)).toBe(true);
      expect(decryptedSecret.startsWith('S')).toBe(true);
      expect(decryptedSecret.length).toBe(56);

      // Should identify as secret seed
      const seedType = StrKeyHelper.getStrKeyType(decryptedSecret);
      expect(seedType.isValid).toBe(true);
      expect(seedType.type).toBe('secretSeed');
    });

    it('should validate keypair consistency using StrKey operations', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Decrypt secret
      const decryptedSecret = encryptionService.deserializeAndDecrypt(
        keyMaterial.encryptedData,
      );

      // Create keypair from secret and verify public key matches
      const keypair = Keypair.fromSecret(decryptedSecret);
      expect(keypair.publicKey()).toBe(keyMaterial.publicKey);
    });
  });

  describe('Signing Operations', () => {
    it('should sign data and verify signature with StrKey-validated keys', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Validate public key format
      expect(StrKeyHelper.isValidEd25519PublicKey(keyMaterial.publicKey)).toBe(true);

      // Sign data
      const testData = Buffer.from('test transaction data');
      const signature = await keyManagementService.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: testData,
        publicKey: keyMaterial.publicKey,
      });

      // Signature should reference the validated public key
      expect(signature.publicKey).toBe(keyMaterial.publicKey);
      expect(StrKeyHelper.isValidEd25519PublicKey(signature.publicKey)).toBe(true);
      expect(signature.signature).toBeDefined();
    });

    it('should handle multiple signing operations with validated keys', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const testData1 = Buffer.from('transaction 1');
      const testData2 = Buffer.from('transaction 2');
      const testData3 = Buffer.from('transaction 3');

      const sig1 = await keyManagementService.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: testData1,
        publicKey: keyMaterial.publicKey,
      });

      const sig2 = await keyManagementService.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: testData2,
        publicKey: keyMaterial.publicKey,
      });

      const sig3 = await keyManagementService.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: testData3,
        publicKey: keyMaterial.publicKey,
      });

      // All signatures should use the same valid public key
      expect(sig1.publicKey).toBe(keyMaterial.publicKey);
      expect(sig2.publicKey).toBe(keyMaterial.publicKey);
      expect(sig3.publicKey).toBe(keyMaterial.publicKey);

      // All signatures should be different
      expect(sig1.signature).not.toBe(sig2.signature);
      expect(sig2.signature).not.toBe(sig3.signature);
      expect(sig1.signature).not.toBe(sig3.signature);

      // Public key should remain valid
      expect(StrKeyHelper.isValidEd25519PublicKey(sig1.publicKey)).toBe(true);
    });
  });

  describe('Security - Secret Seed Detection', () => {
    it('should detect if encrypted material contains secret seed format', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const decryptedSecret = encryptionService.deserializeAndDecrypt(
        keyMaterial.encryptedData,
      );

      // Should detect secret seed pattern
      expect(StrKeyHelper.looksLikeSecretSeed(decryptedSecret)).toBe(true);
      expect(StrKeyHelper.looksLikeSecretSeed(keyMaterial.publicKey)).toBe(false);
    });

    it('should safely mask keys for logging', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const maskedPublic = StrKeyHelper.maskKey(keyMaterial.publicKey);
      const decryptedSecret = encryptionService.deserializeAndDecrypt(
        keyMaterial.encryptedData,
      );
      const maskedSecret = StrKeyHelper.maskKey(decryptedSecret);

      // Masked versions should not contain the full key
      expect(maskedPublic).not.toBe(keyMaterial.publicKey);
      expect(maskedSecret).not.toBe(decryptedSecret);

      // Should contain asterisks
      expect(maskedPublic).toContain('*');
      expect(maskedSecret).toContain('*');

      // Should start with correct prefix
      expect(maskedPublic.startsWith('G')).toBe(true);
      expect(maskedSecret.startsWith('S')).toBe(true);
    });
  });

  describe('Audit Log Integration', () => {
    it('should log operations with validated public keys', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId: 'test-user' },
      });

      const auditLog = keyManagementService.getAuditLog(10);
      const generateLog = auditLog.find((log) => log.operation === 'GENERATE');

      expect(generateLog).toBeDefined();
      expect(generateLog?.publicKey).toBe(keyMaterial.publicKey);
      expect(StrKeyHelper.isValidEd25519PublicKey(generateLog!.publicKey)).toBe(true);
    });

    it('should audit signing operations with valid keys', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      await keyManagementService.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test'),
        publicKey: keyMaterial.publicKey,
      });

      const auditLog = keyManagementService.getAuditLog(10);
      const signLog = auditLog.find((log) => log.operation === 'SIGN');

      expect(signLog).toBeDefined();
      expect(StrKeyHelper.isValidEd25519PublicKey(signLog!.publicKey)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid public key formats gracefully', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const invalidPublicKey = 'GINVALIDKEY123';

      // StrKey helper should detect invalid format
      expect(StrKeyHelper.isValidEd25519PublicKey(invalidPublicKey)).toBe(false);

      // Attempting to sign with invalid public key should still work
      // (public key is just for audit, not used in signing)
      const signature = await keyManagementService.sign({
        encryptedKeyMaterial: keyMaterial.encryptedData,
        dataToSign: Buffer.from('test'),
        publicKey: invalidPublicKey,
      });

      expect(signature).toBeDefined();
    });

    it('should handle corrupted encrypted material', async () => {
      const corruptedData = 'corrupted-encrypted-data';

      await expect(
        keyManagementService.sign({
          encryptedKeyMaterial: corruptedData,
          dataToSign: Buffer.from('test'),
          publicKey: 'GTEST',
        }),
      ).rejects.toThrow();
    });
  });

  describe('Raw Buffer Encoding/Decoding', () => {
    it('should encode and decode raw key buffers', async () => {
      // Generate a keypair using stellar-sdk directly
      const keypair = Keypair.random();
      const rawPublicKey = keypair.rawPublicKey();
      const rawSecretKey = keypair.rawSecretKey();

      // Encode using StrKeyHelper
      const encodedPublic = StrKeyHelper.encodeEd25519PublicKey(rawPublicKey);
      const encodedSecret = StrKeyHelper.encodeEd25519SecretSeed(rawSecretKey);

      // Validate encoded values
      expect(StrKeyHelper.isValidEd25519PublicKey(encodedPublic)).toBe(true);
      expect(StrKeyHelper.isValidEd25519SecretSeed(encodedSecret)).toBe(true);

      // Decode back
      const decodedPublic = StrKeyHelper.decodeEd25519PublicKey(encodedPublic);
      const decodedSecret = StrKeyHelper.decodeEd25519SecretSeed(encodedSecret);

      // Should match original buffers
      expect(decodedPublic).toEqual(rawPublicKey);
      expect(decodedSecret).toEqual(rawSecretKey);
    });

    it('should work with key management service generated keys', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      // Decode the public key to raw bytes
      const rawPublicKey = StrKeyHelper.decodeEd25519PublicKey(keyMaterial.publicKey);

      expect(Buffer.isBuffer(rawPublicKey)).toBe(true);
      expect(rawPublicKey.length).toBe(32);

      // Re-encode should produce same result
      const reencoded = StrKeyHelper.encodeEd25519PublicKey(rawPublicKey);
      expect(reencoded).toBe(keyMaterial.publicKey);
    });
  });

  describe('Statistics Integration', () => {
    it('should generate statistics with validated keys', async () => {
      // Generate multiple keys
      await keyManagementService.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await keyManagementService.generateKey({ keyType: KeyType.STELLAR_ED25519 });
      await keyManagementService.generateKey({ keyType: KeyType.STELLAR_ED25519 });

      const stats = keyManagementService.getStatistics();

      expect(stats.totalKeysGenerated).toBeGreaterThanOrEqual(3);

      // All public keys in audit log should be valid
      const auditLog = keyManagementService.getAuditLog(100);
      const generateLogs = auditLog.filter((log) => log.operation === 'GENERATE');

      generateLogs.forEach((log) => {
        if (log.publicKey !== 'failed') {
          expect(StrKeyHelper.isValidEd25519PublicKey(log.publicKey)).toBe(true);
        }
      });
    });
  });

  describe('Key Type Detection', () => {
    it('should detect different Stellar key types', async () => {
      const keyMaterial = await keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const decryptedSecret = encryptionService.deserializeAndDecrypt(
        keyMaterial.encryptedData,
      );

      // Detect public key
      const publicKeyType = StrKeyHelper.getStrKeyType(keyMaterial.publicKey);
      expect(publicKeyType.type).toBe('publicKey');

      // Detect secret seed
      const secretType = StrKeyHelper.getStrKeyType(decryptedSecret);
      expect(secretType.type).toBe('secretSeed');

      // Test with hash types
      const hash = Buffer.alloc(32).fill(0x42);
      const preAuthTx = StrKeyHelper.encodePreAuthTx(hash);
      const sha256Hash = StrKeyHelper.encodeSha256Hash(hash);

      expect(StrKeyHelper.getStrKeyType(preAuthTx).type).toBe('preAuthTx');
      expect(StrKeyHelper.getStrKeyType(sha256Hash).type).toBe('sha256Hash');
    });
  });
});
