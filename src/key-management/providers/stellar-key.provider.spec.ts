import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StellarKeyProvider } from './stellar-key.provider';
import { EncryptionService, DecryptionError } from '../../encryption/encryption.service';
import { KeyType } from '../domain/key-types';

describe('StellarKeyProvider', () => {
  let provider: StellarKeyProvider;
  let encryptionService: EncryptionService;

  beforeEach(async () => {
    const mockConfigService = {
      get: jest.fn().mockReturnValue('test-encryption-key-12345-long-enough-32-chars'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarKeyProvider,
        EncryptionService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    provider = module.get<StellarKeyProvider>(StellarKeyProvider);
    encryptionService = module.get<EncryptionService>(EncryptionService);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // generateKeyPair
  // ─────────────────────────────────────────────────────────────────────────────
  describe('generateKeyPair', () => {
    it('should generate a valid Stellar Ed25519 keypair', async () => {
      const result = await provider.generateKeyPair(KeyType.STELLAR_ED25519);

      expect(result.publicKey).toBeDefined();
      expect(result.privateKeyMaterial).toBeDefined();
      expect(result.keyType).toBe(KeyType.STELLAR_ED25519);
      // Stellar public keys start with G
      expect(result.publicKey).toMatch(/^G/);
      // Stellar secret keys start with S
      expect(result.privateKeyMaterial).toMatch(/^S/);
    });

    it('should generate different keypairs on each call', async () => {
      const kp1 = await provider.generateKeyPair(KeyType.STELLAR_ED25519);
      const kp2 = await provider.generateKeyPair(KeyType.STELLAR_ED25519);

      expect(kp1.publicKey).not.toBe(kp2.publicKey);
      expect(kp1.privateKeyMaterial).not.toBe(kp2.privateKeyMaterial);
    });

    it('should throw for unsupported key type', async () => {
      await expect(
        provider.generateKeyPair(KeyType.ETHEREUM_SECP256K1),
      ).rejects.toThrow('Unsupported key type');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // sign
  // ─────────────────────────────────────────────────────────────────────────────
  describe('sign', () => {
    it('should sign data successfully', async () => {
      const kp = await provider.generateKeyPair(KeyType.STELLAR_ED25519);
      const encryptedMaterial = encryptionService.encryptAndSerialize(
        kp.privateKeyMaterial,
      );

      const result = await provider.sign(
        encryptedMaterial,
        Buffer.from('test-payload'),
      );

      expect(result.signature).toBeDefined();
      expect(result.algorithm).toBe('ed25519');
      expect(result.publicKey).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
    });

    it('should propagate DecryptionError (not wrap it) when decrypt fails', async () => {
      const decryptError = new DecryptionError(
        'Decryption failed',
        'DECRYPTION_FAILED',
      );

      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw decryptError;
        });

      let caught: Error | undefined;
      try {
        await provider.sign('corrupted-material', Buffer.from('data'));
      } catch (e) {
        caught = e as Error;
      }

      // Must be the exact DecryptionError instance — not wrapped in generic Error
      expect(caught).toBeInstanceOf(DecryptionError);
      expect((caught as DecryptionError).code).toBe('DECRYPTION_FAILED');
    });

    it('should propagate DecryptionError with INVALID_KEY code', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Wrong key', 'INVALID_KEY');
        });

      let caught: DecryptionError | undefined;
      try {
        await provider.sign('stale-material', Buffer.from('data'));
      } catch (e) {
        caught = e as DecryptionError;
      }

      expect(caught).toBeInstanceOf(DecryptionError);
      expect(caught!.code).toBe('INVALID_KEY');
    });

    it('should propagate DecryptionError with INVALID_DATA code', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Bad data format', 'INVALID_DATA');
        });

      let caught: DecryptionError | undefined;
      try {
        await provider.sign('malformed-json', Buffer.from('data'));
      } catch (e) {
        caught = e as DecryptionError;
      }

      expect(caught).toBeInstanceOf(DecryptionError);
      expect(caught!.code).toBe('INVALID_DATA');
    });

    it('should throw generic error for non-decrypt signing failures', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('SAEZIVNMQF5T2BQXLSZ2EL4IABKLFN7ZWDBEXYZ123');

      // Return an invalid secret that stellar-sdk will reject
      // This simulates a signing failure after successful decryption
      let caught: Error | undefined;
      try {
        await provider.sign(
          'some-encrypted-material',
          Buffer.from('data'),
        );
      } catch (e) {
        caught = e as Error;
      }

      // Should be a generic error, NOT a DecryptionError
      expect(caught).toBeDefined();
      expect(caught).not.toBeInstanceOf(DecryptionError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // validateKeyPair
  // ─────────────────────────────────────────────────────────────────────────────
  describe('validateKeyPair', () => {
    it('should return true for a matching keypair', async () => {
      const kp = await provider.generateKeyPair(KeyType.STELLAR_ED25519);
      const encryptedMaterial = encryptionService.encryptAndSerialize(
        kp.privateKeyMaterial,
      );

      const isValid = await provider.validateKeyPair(
        kp.publicKey,
        encryptedMaterial,
      );

      expect(isValid).toBe(true);
    });

    it('should return false for a mismatched public key', async () => {
      const kp1 = await provider.generateKeyPair(KeyType.STELLAR_ED25519);
      const kp2 = await provider.generateKeyPair(KeyType.STELLAR_ED25519);
      const encryptedMaterial1 = encryptionService.encryptAndSerialize(
        kp1.privateKeyMaterial,
      );

      // Validate kp1's encrypted material against kp2's public key
      const isValid = await provider.validateKeyPair(
        kp2.publicKey,
        encryptedMaterial1,
      );

      expect(isValid).toBe(false);
    });

    it('should propagate DecryptionError during validation', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockImplementation(() => {
          throw new DecryptionError('Decryption failed', 'DECRYPTION_FAILED');
        });

      await expect(
        provider.validateKeyPair('GSOME_KEY', 'corrupted-material'),
      ).rejects.toThrow(DecryptionError);
    });

    it('should return false for other (non-decrypt) validation errors', async () => {
      jest
        .spyOn(encryptionService, 'deserializeAndDecrypt')
        .mockReturnValue('SDECRYPTEDBUTRANDOM123456789');

      // The signing step will fail with invalid key format (not DecryptionError)
      // validateKeyPair should catch that and return false
      const isValid = await provider.validateKeyPair(
        'GSOME_KEY',
        'some-material',
      );

      expect(isValid).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // getProviderName
  // ─────────────────────────────────────────────────────────────────────────────
  describe('getProviderName', () => {
    it('should return StellarKeyProvider', () => {
      expect(provider.getProviderName()).toBe('StellarKeyProvider');
    });
  });
});
