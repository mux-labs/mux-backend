import { Injectable, Logger } from '@nestjs/common';
import { IKeyProvider } from '../interfaces/key-provider.interface';
import {
  GeneratedKeyPair,
  SignatureResult,
  KeyType,
} from '../domain/key-types';
import {
  EncryptionService,
  DecryptionError,
} from '../../encryption/encryption.service';
import { Keypair } from 'stellar-sdk';
import { StrKeyHelper } from '../utils/strkey.helper';

/**
 * Stellar Ed25519 key provider implementation
 *
 * In production, using stellar-sdk:
 */
@Injectable()
export class StellarKeyProvider implements IKeyProvider {
  private readonly logger = new Logger(StellarKeyProvider.name);

  constructor(private readonly encryptionService: EncryptionService) {}

  async generateKeyPair(keyType: KeyType): Promise<GeneratedKeyPair> {
    if (keyType !== KeyType.STELLAR_ED25519) {
      throw new Error(`Unsupported key type: ${keyType}`);
    }

    try {
      // In production, use stellar-sdk to generate a random Ed25519 keypair
      const keypair = Keypair.random();

      const publicKey = keypair.publicKey();
      const privateKey = keypair.secret();

      this.logger.log(
        'Generated new Stellar Ed25519 keypair using stellar-sdk',
      );

      return {
        publicKey,
        privateKeyMaterial: privateKey,
        keyType: KeyType.STELLAR_ED25519,
        metadata: {
          algorithm: 'ed25519',
          generatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error('Failed to generate Stellar keypair:', error);
      throw new Error('Keypair generation failed');
    }
  }

  async sign(
    encryptedKeyMaterial: string,
    dataToSign: Buffer,
  ): Promise<SignatureResult> {
    try {
      // Decrypt the private key material (may throw DecryptionError)
      const privateKeyMaterial =
        this.encryptionService.deserializeAndDecrypt(encryptedKeyMaterial);

      // Validate it's a proper secret seed
      if (!StrKeyHelper.isValidEd25519SecretSeed(privateKeyMaterial)) {
        throw new Error('Invalid Ed25519 secret seed format');
      }

      // Sign the data
      const keypair = Keypair.fromSecret(privateKeyMaterial);
      const signature = keypair.sign(dataToSign);

      const publicKey = keypair.publicKey();

      this.logger.log(
        `Successfully signed data with Stellar key (${StrKeyHelper.maskKey(publicKey)})`,
      );

      return {
        signature: signature.toString('base64'),
        publicKey,
        algorithm: 'ed25519',
        timestamp: new Date(),
      };
    } catch (error) {
      // Propagate DecryptionError directly to preserve error context
      if (error instanceof DecryptionError) {
        this.logger.error('Key decryption failed during signing:', {
          code: error.code,
          message: error.message,
        });
        throw error;
      }

      // Handle other signing errors (e.g., invalid key format, stellar-sdk failures)
      this.logger.error('Signing operation failed:', error);
      throw new Error('Signing failed');
    }
  }

  async validateKeyPair(
    publicKey: string,
    encryptedKeyMaterial: string,
  ): Promise<boolean> {
    try {
      // Validate public key format first
      if (!StrKeyHelper.isValidEd25519PublicKey(publicKey)) {
        this.logger.warn('Invalid Ed25519 public key format');
        return false;
      }

      // Test data for validation
      const testData = Buffer.from('validation-test-data');

      // Sign with the private key
      const signatureResult = await this.sign(encryptedKeyMaterial, testData);

      // Verify the signature matches the public key
      return signatureResult.publicKey === publicKey;
    } catch (error) {
      // Propagate DecryptionError so callers can distinguish corrupt key material
      if (error instanceof DecryptionError) {
        throw error;
      }

      this.logger.error('Keypair validation failed:', error);
      return false;
    }
  }

  getProviderName(): string {
    return 'StellarKeyProvider';
  }
}
