import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KeyManagementService } from './key-management.service';
import { EncryptionService, DecryptionError } from '../encryption/encryption.service';
import { KeyType } from './domain/key-types';
import { KeyDecryptionException } from './exceptions/key-decryption.exception';

describe('KeyManagementService', () => {
  let service: KeyManagementService;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key-12345-long-enough-32-chars'),
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

  // ─────────────────────────────────────────────────────────────────────────────
  // generateKey
  // ─────────────────────────────────────────────────────────────────────────────
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

    it('should audit key generation failure', async () => {
      jest
        .spyOn(encryptionService, 'encryptAndSerialize')
        .mockImplementation(() => {
          throw new Error('Encryption provider unavailable');
        });

      await expect(
        service.generateKey({ keyType: KeyType.STELLAR_ED25519 }),
      ).rejects.toThrow('Key generation failed');

      const auditLog = service.getAuditLog();
      const failureEntry = auditLog[auditLog.length - 1];
      expect(failureEntry).toMatchObject({
        operation: 'GENERATE',
        success: false,
      });
      expect(failureEntry.errorMessage).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // sign
  // ─────────────────────────────────────────────────────────────────────────────
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

    it('should throw KeyDecryptionException when decrypt fails with DECRYPTION_FAILED', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      await expect(
        service.sign({
          encryptedKeyMaterial: 'corrupted-material',
          dataToSign: Buffer.from('data'),
          publicKey: 'GABC123DEFGH',
        }),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('should throw KeyDecryptionException when decrypt fails with INVALID_KEY', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Invalid key', 'INVALID_KEY');
        });

      let caught: KeyDecryptionException | undefined;

      try {
        await service.sign({
          encryptedKeyMaterial: 'stale-material',
          dataToSign: Buffer.from('data'),
          publicKey: 'GABC123DEFGH',
        });
      } catch (err) {
        caught = err as KeyDecryptionException;
      }

      expect(caught).toBeInstanceOf(KeyDecryptionException);
      expect(caught!.reason).toBe('INVALID_KEY');
      expect(caught!.getStatus()).toBe(422);
    });

    it('should throw KeyDecryptionException when decrypt fails with INVALID_DATA', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Invalid data format', 'INVALID_DATA');
        });

      let caught: KeyDecryptionException | undefined;

      try {
        await service.sign({
          encryptedKeyMaterial: 'bad-json',
          dataToSign: Buffer.from('data'),
          publicKey: 'GABC123DEFGH',
        });
      } catch (err) {
        caught = err as KeyDecryptionException;
      }

      expect(caught).toBeInstanceOf(KeyDecryptionException);
      expect(caught!.reason).toBe('INVALID_DATA');
    });

    it('should record a failed audit entry when decrypt fails', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      try {
        await service.sign({
          encryptedKeyMaterial: 'bad',
          dataToSign: Buffer.from('d'),
          publicKey: 'GTEST',
        });
      } catch {
        // expected
      }

      const auditLog = service.getAuditLog();
      const failEntry = [...auditLog]
        .reverse()
        .find((e) => e.operation === 'SIGN' && !e.success);

      expect(failEntry).toBeDefined();
      expect(failEntry!.errorMessage).toContain('decrypt_failure');
    });

    it('should throw generic error for non-decrypt signing failures', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('valid-private-key');

      // Force a non-decrypt error at the signing step
      const stellarProvider = (service as any).providers.get(
        KeyType.STELLAR_ED25519,
      );
      jest.spyOn(stellarProvider, 'sign').mockRejectedValue(
        new Error('Network timeout'),
      );

      await expect(
        service.sign({
          encryptedKeyMaterial: 'some-material',
          dataToSign: Buffer.from('data'),
          publicKey: 'GTEST',
        }),
      ).rejects.toThrow('Signing operation failed');
    });

    it('should NOT throw KeyDecryptionException for non-decrypt signing failures', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('valid-private-key');

      const stellarProvider = (service as any).providers.get(
        KeyType.STELLAR_ED25519,
      );
      jest
        .spyOn(stellarProvider, 'sign')
        .mockRejectedValue(new Error('Network timeout'));

      let caughtException: Error | undefined;
      try {
        await service.sign({
          encryptedKeyMaterial: 'some-material',
          dataToSign: Buffer.from('data'),
          publicKey: 'GTEST',
        });
      } catch (e) {
        caughtException = e as Error;
      }

      expect(caughtException).toBeDefined();
      expect(caughtException).not.toBeInstanceOf(KeyDecryptionException);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateKey
  // ─────────────────────────────────────────────────────────────────────────────
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

    it('should throw KeyDecryptionException when decrypt fails during validate', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      await expect(
        service.validateKey(
          'GSOME_PUBLIC_KEY',
          'corrupted-material',
          KeyType.STELLAR_ED25519,
        ),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('should return false for non-decrypt validation errors', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('valid-material');

      const stellarProvider = (service as any).providers.get(
        KeyType.STELLAR_ED25519,
      );
      jest.spyOn(stellarProvider, 'validateKeyPair').mockRejectedValue(
        new Error('Unexpected internal error'),
      );

      const result = await service.validateKey(
        'GSOME_PUBLIC_KEY',
        'some-material',
        KeyType.STELLAR_ED25519,
      );

      expect(result).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // reEncryptKey
  // ─────────────────────────────────────────────────────────────────────────────
  describe('reEncryptKey', () => {
    it('should re-encrypt key material successfully', async () => {
      const keyMaterial = await service.generateKey({
        keyType: KeyType.STELLAR_ED25519,
      });

      const result = await service.reEncryptKey(
        keyMaterial.encryptedData,
        KeyType.STELLAR_ED25519,
        'key-001',
      );

      expect(result).toHaveProperty('encryptedData');
      expect(result.encryptedData).not.toBe(keyMaterial.encryptedData);
      expect(result.encryptionVersion).toBe(2);
      expect(result.keyType).toBe(KeyType.STELLAR_ED25519);
    });

    it('should throw KeyDecryptionException when existing material cannot be decrypted', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      await expect(
        service.reEncryptKey(
          'corrupted-material',
          KeyType.STELLAR_ED25519,
          'key-002',
        ),
      ).rejects.toThrow(KeyDecryptionException);
    });

    it('should include keyId in KeyDecryptionException for re-encrypt', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Invalid data', 'INVALID_DATA');
        });

      let caught: KeyDecryptionException | undefined;
      try {
        await service.reEncryptKey(
          'bad-material',
          KeyType.STELLAR_ED25519,
          'key-xyz',
        );
      } catch (e) {
        caught = e as KeyDecryptionException;
      }

      expect(caught).toBeInstanceOf(KeyDecryptionException);
      expect(caught!.keyId).toBe('key-xyz');
      expect(caught!.reason).toBe('INVALID_DATA');
    });

    it('should throw generic error for non-decrypt re-encrypt failures', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('decrypted-key');

      jest
        .spyOn(encryptionService, 'encryptAndSerialize')
        .mockImplementation(() => {
          throw new Error('KMS unavailable');
        });

      await expect(
        service.reEncryptKey(
          'valid-but-re-encrypt-fails',
          KeyType.STELLAR_ED25519,
        ),
      ).rejects.toThrow('Key re-encryption failed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // security properties
  // ─────────────────────────────────────────────────────────────────────────────
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

    it('should not include crypto error details in KeyDecryptionException message', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError(
            'EVP_DecryptFinal_ex:bad decrypt:0x7f...internal',
            'DECRYPTION_FAILED',
          );
        });

      let caught: KeyDecryptionException | undefined;
      try {
        await service.sign({
          encryptedKeyMaterial: 'bad',
          dataToSign: Buffer.from('d'),
          publicKey: 'GTEST',
        });
      } catch (e) {
        caught = e as KeyDecryptionException;
      }

      // The HTTP response body should NOT leak internal crypto error details
      const body = caught!.getResponse() as any;
      expect(body.message).not.toContain('EVP_DecryptFinal_ex');
      expect(body.message).not.toContain('0x7f');
    });
  });
});
