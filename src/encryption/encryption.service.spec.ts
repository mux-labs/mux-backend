import { Test, TestingModule } from '@nestjs/testing';
import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  let service: EncryptionService;
  const originalEnv = process.env;

  beforeEach(async () => {
    // Mock environment variables
    process.env = {
      ...originalEnv,
      WALLET_ENCRYPTION_KEY: 'test-encryption-key-32-chars-long-minimum',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [EncryptionService],
    }).compile();

    service = module.get<EncryptionService>(EncryptionService);
  });

  afterAll(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt data correctly', () => {
      const plainText = 'test-private-key-data';
      
      const encrypted = service.encrypt(plainText);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decryptedData).toBe(plainText);
    });

    it('should produce different encrypted values for same input', () => {
      const plainText = 'test-private-key-data';
      
      const encrypted1 = service.encrypt(plainText);
      const encrypted2 = service.encrypt(plainText);

      // Should be different due to random salt/IV
      expect(encrypted1.encryptedData).not.toBe(encrypted2.encryptedData);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      expect(encrypted1.salt).not.toBe(encrypted2.salt);
    });

    it('should handle empty string', () => {
      const plainText = '';
      
      const encrypted = service.encrypt(plainText);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decryptedData).toBe('');
    });

    it('should handle long strings', () => {
      const plainText = 'a'.repeat(10000); // 10KB string
      
      const encrypted = service.encrypt(plainText);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decryptedData).toBe(plainText);
    });
  });

  describe('encryptSimple/decryptSimple', () => {
    it('should encrypt and decrypt using simple interface', () => {
      const plainText = 'test-private-key-data';
      
      const encrypted = service.encryptSimple(plainText);
      const decrypted = service.decryptSimple(encrypted);

      expect(decrypted.success).toBe(true);
      expect(decrypted.decryptedData).toBe(plainText);
    });

    it('should handle malformed encrypted string', () => {
      const malformedEncrypted = 'invalid:format:string';
      
      const decrypted = service.decryptSimple(malformedEncrypted);

      expect(decrypted.success).toBe(false);
      expect(decrypted.error).toContain('Simple decryption failed');
    });

    it('should handle incomplete encrypted string', () => {
      const incompleteEncrypted = 'salt:iv';
      
      const decrypted = service.decryptSimple(incompleteEncrypted);

      expect(decrypted.success).toBe(false);
      expect(decrypted.error).toContain('Simple decryption failed');
    });
  });

  describe('error handling', () => {
    it('should handle decryption with wrong key', async () => {
      const plainText = 'test-private-key-data';
      
      // Encrypt with original key
      const encrypted = service.encrypt(plainText);
      
      // Change encryption key
      process.env.WALLET_ENCRYPTION_KEY = 'different-encryption-key-32-chars-long';
      
      // Create new service instance with different key
      const newService = new EncryptionService();
      
      const decrypted = newService.decrypt(encrypted);

      expect(decrypted.success).toBe(false);
      expect(decrypted.error).toContain('Decryption failed');
    });

    it('should handle invalid encrypted data', () => {
      const invalidEncrypted = {
        encryptedData: 'invalid-data',
        iv: 'invalid-iv',
        salt: 'invalid-salt',
      };
      
      const decrypted = service.decrypt(invalidEncrypted);

      expect(decrypted.success).toBe(false);
      expect(decrypted.error).toContain('Decryption failed');
    });

    it('should handle empty encrypted data', () => {
      const emptyEncrypted = {
        encryptedData: '',
        iv: '',
        salt: '',
      };
      
      const decrypted = service.decrypt(emptyEncrypted);

      expect(decrypted.success).toBe(false);
      expect(decrypted.error).toContain('Decryption failed');
    });
  });

  describe('validateEncryptionKey', () => {
    it('should validate correct encryption key', () => {
      const isValid = service.validateEncryptionKey();
      expect(isValid).toBe(true);
    });

    it('should fail validation with wrong key', async () => {
      // Change encryption key
      process.env.WALLET_ENCRYPTION_KEY = 'different-encryption-key-32-chars-long';
      
      // Create new service instance with different key
      const newService = new EncryptionService();
      
      const isValid = newService.validateEncryptionKey();
      expect(isValid).toBe(false);
    });
  });

  describe('environment key management', () => {
    it('should throw error when no encryption key is provided', () => {
      delete process.env.WALLET_ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      delete process.env.WALLET_PRIVATE_KEY_ENCRYPTION;

      expect(() => new EncryptionService()).toThrow(
        'WALLET_ENCRYPTION_KEY environment variable is required'
      );
    });

    it('should accept alternative environment variable names', () => {
      delete process.env.WALLET_ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = 'alternative-key-32-chars-long-minimum';

      expect(() => new EncryptionService()).not.toThrow();
    });

    it('should reject short encryption keys', () => {
      process.env.WALLET_ENCRYPTION_KEY = 'short-key';

      expect(() => new EncryptionService()).toThrow(
        'WALLET_ENCRYPTION_KEY environment variable is required'
      );
    });
  });

  describe('generateSecureKey', () => {
    it('should generate a secure key of correct length', () => {
      const key = EncryptionService.generateSecureKey();
      
      expect(key).toBeDefined();
      expect(key.length).toBeGreaterThan(32);
    });

    it('should generate different keys each time', () => {
      const key1 = EncryptionService.generateSecureKey();
      const key2 = EncryptionService.generateSecureKey();
      
      expect(key1).not.toBe(key2);
    });
  });
});
