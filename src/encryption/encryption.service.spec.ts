import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EncryptionService, DecryptionError } from './encryption.service';

describe('EncryptionService', () => {
  let service: EncryptionService;
  let configService: ConfigService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EncryptionService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<EncryptionService>(EncryptionService);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initialization', () => {
    it('should throw error if WALLET_ENCRYPTION_KEY is not set', () => {
      jest.spyOn(configService, 'get').mockReturnValue(undefined);

      expect(() => new EncryptionService(configService)).toThrow(
        'WALLET_ENCRYPTION_KEY environment variable is required',
      );
    });

    it('should initialize successfully with valid encryption key', () => {
      jest.spyOn(configService, 'get').mockReturnValue('test-encryption-key-12345');

      expect(() => new EncryptionService(configService)).not.toThrow();
    });
  });

  describe('encryption and decryption', () => {
    beforeEach(() => {
      jest.spyOn(configService, 'get').mockReturnValue('test-encryption-key-12345');
      service = new EncryptionService(configService);
    });

    it('should encrypt and decrypt plaintext correctly', () => {
      const plaintext = 'super-secret-private-key-12345';
      
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should produce different encrypted values for same plaintext', () => {
      const plaintext = 'same-plaintext';
      
      const encrypted1 = service.encrypt(plaintext);
      const encrypted2 = service.encrypt(plaintext);

      expect(encrypted1.encryptedData).not.toBe(encrypted2.encryptedData);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.tag).not.toBe(encrypted2.tag);
    });

    it('should encrypt and decrypt complex strings', () => {
      const complexPlaintext = '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKB\\nxI/6+TqSgUqT0d5l0KGBZtZnQj5M6qJ8L5M8V5J9K5A8B5K5L8K5M8V5J9K5A8B5\\n-----END PRIVATE KEY-----';
      
      const encrypted = service.encrypt(complexPlaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(complexPlaintext);
    });

    it('should handle empty strings', () => {
      const plaintext = '';
      
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should handle unicode characters', () => {
      const plaintext = '🔐 🔑 🚀 测试 🔒';
      
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('serialization', () => {
    beforeEach(() => {
      jest.spyOn(configService, 'get').mockReturnValue('test-encryption-key-12345');
      service = new EncryptionService(configService);
    });

    it('should serialize and deserialize encryption result', () => {
      const plaintext = 'test-serialization';
      
      const encrypted = service.encrypt(plaintext);
      const serialized = service.serializeForStorage(encrypted);
      const deserialized = service.deserializeFromStorage(serialized);
      const decrypted = service.decrypt(deserialized);

      expect(decrypted).toBe(plaintext);
    });

    it('should throw error for invalid serialized data', () => {
      const invalidData = 'invalid-json-data';

      expect(() => service.deserializeFromStorage(invalidData)).toThrow(
        'Invalid encrypted data format',
      );
    });

    it('should handle encryptAndSerialize and deserializeAndDecrypt', () => {
      const plaintext = 'test-convenience-methods';
      
      const serialized = service.encryptAndSerialize(plaintext);
      const decrypted = service.deserializeAndDecrypt(serialized);

      expect(decrypted).toBe(plaintext);
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      jest.spyOn(configService, 'get').mockReturnValue('test-encryption-key-12345');
      service = new EncryptionService(configService);
    });

    it('should throw DecryptionError for invalid encrypted data', () => {
      const invalidEncrypted = {
        encryptedData: 'invalid-data',
        iv: 'invalid-iv',
        tag: 'invalid-tag',
      };

      expect(() => service.decrypt(invalidEncrypted)).toThrow(DecryptionError);
    });

    it('should throw DecryptionError for wrong IV', () => {
      const plaintext = 'test-data';
      const encrypted = service.encrypt(plaintext);
      
      const wrongIvEncrypted = {
        ...encrypted,
        iv: 'wrong-iv-123456789012',
      };

      expect(() => service.decrypt(wrongIvEncrypted)).toThrow(DecryptionError);
    });

    it('should throw DecryptionError for wrong tag', () => {
      const plaintext = 'test-data';
      const encrypted = service.encrypt(plaintext);
      
      const wrongTagEncrypted = {
        ...encrypted,
        tag: 'wrong-tag-123456789012',
      };

      expect(() => service.decrypt(wrongTagEncrypted)).toThrow(DecryptionError);
    });

    it('should handle decryption errors with proper error codes', () => {
      const invalidEncrypted = {
        encryptedData: 'invalid',
        iv: 'invalid',
        tag: 'invalid',
      };

      try {
        service.decrypt(invalidEncrypted);
        fail('Expected DecryptionError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DecryptionError);
        expect((error as DecryptionError).code).toBeDefined();
        expect(['DECRYPTION_FAILED', 'INVALID_KEY', 'INVALID_DATA']).toContain(
          (error as DecryptionError).code,
        );
      }
    });
  });

  describe('configuration validation', () => {
    beforeEach(() => {
      jest.spyOn(configService, 'get').mockReturnValue('test-encryption-key-12345');
      service = new EncryptionService(configService);
    });

    it('should validate configuration successfully', () => {
      expect(service.validateConfiguration()).toBe(true);
    });

    it('should return false for invalid configuration', () => {
      // Mock the encryption method to throw an error
      jest.spyOn(service, 'encrypt').mockImplementation(() => {
        throw new Error('Encryption failed');
      });

      expect(service.validateConfiguration()).toBe(false);
    });
  });

  describe('key derivation', () => {
    it('should derive same key from same input', () => {
      const key1 = 'test-encryption-key-12345';
      const key2 = 'test-encryption-key-12345';

      jest.spyOn(configService, 'get').mockReturnValue(key1);
      const service1 = new EncryptionService(configService);

      jest.spyOn(configService, 'get').mockReturnValue(key2);
      const service2 = new EncryptionService(configService);

      const plaintext = 'same-plaintext';
      
      const encrypted1 = service1.encrypt(plaintext);
      const encrypted2 = service2.encrypt(plaintext);

      // Should be able to decrypt across instances with same key
      expect(service2.decrypt(encrypted1)).toBe(plaintext);
      expect(service1.decrypt(encrypted2)).toBe(plaintext);
    });

    it('should derive different keys from different inputs', () => {
      const key1 = 'test-encryption-key-12345';
      const key2 = 'different-encryption-key-67890';

      jest.spyOn(configService, 'get').mockReturnValue(key1);
      const service1 = new EncryptionService(configService);

      jest.spyOn(configService, 'get').mockReturnValue(key2);
      const service2 = new EncryptionService(configService);

      const plaintext = 'same-plaintext';
      
      const encrypted1 = service1.encrypt(plaintext);
      const encrypted2 = service2.encrypt(plaintext);

      // Should not be able to decrypt across instances with different keys
      expect(() => service2.decrypt(encrypted1)).toThrow(DecryptionError);
      expect(() => service1.decrypt(encrypted2)).toThrow(DecryptionError);
    });
  });
});
