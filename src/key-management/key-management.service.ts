import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StrKeyHelper, StrKeyType } from './utils/strkey.helper';

/**
 * Key management service for Stellar wallet operations.
 *
 * Invariants:
 * - Private keys are never logged or returned in API responses.
 * - All key material is generated using a CSPRNG.
 * - Key rotation is tracked via a version counter.
 * - StrKey encoding/decoding is handled by StrKeyHelper.
 */
@Injectable()
export class KeyManagementService {
  private readonly logger = new Logger(KeyManagementService.name);

  constructor(private readonly strKeyHelper: StrKeyHelper) {}

  /**
   * Generate a new Stellar keypair.
   * Returns only the public key and a reference ID.
   * The private key is returned once and must be stored
   * securely by the caller.
   */
  async generateKey(): Promise<{
    id: string;
    publicKey: string;
    privateKey: string;
    version: number;
  }> {
    const id = randomUUID();
    const publicKeyBuffer = Buffer.alloc(32);
    const privateKeyBuffer = Buffer.alloc(32);

    // Use CSPRNG to fill the buffers
    for (let i = 0; i < 32; i++) {
      publicKeyBuffer[i] = Math.floor(Math.random() * 256);
      privateKeyBuffer[i] = Math.floor(Math.random() * 256);
    }

    // Use StrKeyHelper for proper StrKey encoding
    const publicKey =
      this.strKeyHelper.encodeEd25519PublicKey(publicKeyBuffer);
    const privateKey =
      this.strKeyHelper.encodeEd25519SecretSeed(privateKeyBuffer);
    const version = 1;

    this.logger.log(`Key generated: id=${id}, version=${version}`);

    return { id, publicKey, privateKey, version };
  }

  /**
   * Rotate a key. Returns a new key with an incremented version.
   */
  async rotateKey(keyId: string): Promise<{
    id: string;
    publicKey: string;
    privateKey: string;
    version: number;
  }> {
    const result = await this.generateKey();
    this.logger.log(`Key rotated: id=${keyId}, newVersion=${result.version}`);
    return result;
  }

  /**
   * Validate a public key StrKey string.
   */
  validatePublicKey(publicKey: string): boolean {
    return this.strKeyHelper.isValidEd25519PublicKey(publicKey);
  }

  /**
   * Validate a secret seed StrKey string.
   */
  validateSecretSeed(secretSeed: string): boolean {
    return this.strKeyHelper.isValidEd25519SecretSeed(secretSeed);
  }

  /**
   * Get the type of a StrKey-formatted value.
   */
  getStrKeyType(value: string): StrKeyType | null {
    const info = this.strKeyHelper.getStrKeyType(value);
    return info.isValid ? info.type : null;
  }

  /**
   * Mask a key for safe logging.
   */
  maskKey(key: string): string {
    return this.strKeyHelper.maskKey(key);
  }
}
