import { Injectable, Logger } from '@nestjs/common';
import { IKeyProvider } from '../interfaces/key-provider.interface';
import {
  GeneratedKeyPair,
  SignatureResult,
  KeyType,
} from '../domain/key-types';
import { EncryptionService } from '../../encryption/encryption.service';
import * as crypto from 'crypto';

/**
 * Stellar Ed25519 key provider implementation
 *
 * In production, replace with stellar-sdk:
 * import { Keypair } from 'stellar-sdk';
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
      // In production, use: const keypair = Keypair.random();
      const keyPair = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      });

      const publicKey = this.formatStellarPublicKey(keyPair.publicKey);
      const privateKey = this.formatStellarPrivateKey(keyPair.privateKey);

      this.logger.log('Generated new Stellar Ed25519 keypair');

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
      // Decrypt the private key material
      const privateKeyMaterial =
        this.encryptionService.deserializeAndDecrypt(encryptedKeyMaterial);

      // Parse the private key
      const privateKey = this.parseStellarPrivateKey(privateKeyMaterial);

      // Sign the data
      // In production, use: const signature = keypair.sign(dataToSign);
      const signature = crypto.sign(null, dataToSign, {
        key: privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      // Derive public key from private key for verification
      const keyObject = crypto.createPrivateKey({
        key: privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      const publicKeyDer = crypto.createPublicKey(keyObject).export({
        type: 'spki',
        format: 'der',
      });

      const publicKey = this.formatStellarPublicKey(publicKeyDer);

      this.logger.log('Successfully signed data with Stellar key');

      return {
        signature: signature.toString('base64'),
        publicKey,
        algorithm: 'ed25519',
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error('Signing operation failed:', error);
      throw new Error('Signing failed');
    }
  }

  async validateKeyPair(
    publicKey: string,
    encryptedKeyMaterial: string,
  ): Promise<boolean> {
    try {
      // Test data for validation
      const testData = Buffer.from('validation-test-data');

      // Sign with the private key
      const signatureResult = await this.sign(encryptedKeyMaterial, testData);

      // Verify the signature matches the public key
      return signatureResult.publicKey === publicKey;
    } catch (error) {
      this.logger.error('Keypair validation failed:', error);
      return false;
    }
  }

  getProviderName(): string {
    return 'StellarKeyProvider';
  }

  /**
   * Formats public key in Stellar format (G... address)
   * In production, use stellar-sdk's encoding
   */
  private formatStellarPublicKey(publicKeyDer: Buffer): string {
    // Simplified format - in production use stellar-sdk's StrKey.encodeEd25519PublicKey
    const hash = crypto.createHash('sha256').update(publicKeyDer).digest();
    return `G${hash.toString('hex').substring(0, 54).toUpperCase()}`;
  }

  /**
   * Formats private key in Stellar format (S... secret)
   * In production, use stellar-sdk's encoding
   */
  private formatStellarPrivateKey(privateKeyDer: Buffer): string {
    // Simplified format - in production use stellar-sdk's StrKey.encodeEd25519SecretSeed
    return privateKeyDer.toString('hex');
  }

  /**
   * Parses Stellar private key back to usable format
   */
  private parseStellarPrivateKey(privateKeyMaterial: string): Buffer {
    return Buffer.from(privateKeyMaterial, 'hex');
  }
}
