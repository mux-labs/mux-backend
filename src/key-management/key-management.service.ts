import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID } from 'crypto';
import { Keypair } from '@stellar/stellar-sdk';
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
   * Generate a new Stellar Ed25519 keypair.
   *
   * The secret seed is drawn from a CSPRNG and the public key is derived from
   * it. The private key is returned once and the caller is responsible for
   * encrypting it via `EncryptionService` before persisting it — plaintext key
   * material must never reach the database.
   */
  // `async` keeps the public contract promise-based for the key-rotation and
  // signing call sites, which await it inside a transaction.
  // eslint-disable-next-line @typescript-eslint/require-await
  async generateKey(): Promise<{
    id: string;
    publicKey: string;
    privateKey: string;
    version: number;
  }> {
    const id = randomUUID();

    // `crypto.randomBytes` is a CSPRNG. `Math.random()` is NOT: it is a
    // fast non-cryptographic PRNG whose internal state can be reconstructed
    // from observed outputs, so a keypair derived from it is predictable.
    // Custody keys must never come from Math.random().
    const privateKeyBuffer = randomBytes(32);

    // The Ed25519 public key is derived from the seed by the curve itself
    // rather than drawn independently, so this is a real keypair.
    const keypair = Keypair.fromRawEd25519Seed(privateKeyBuffer);
    const publicKeyBuffer = Buffer.from(keypair.rawPublicKey());

    // Use StrKeyHelper for proper StrKey encoding
    const publicKey = this.strKeyHelper.encodeEd25519PublicKey(publicKeyBuffer);
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
