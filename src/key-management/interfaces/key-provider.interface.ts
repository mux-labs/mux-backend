import {
  GeneratedKeyPair,
  SignatureResult,
  KeyType,
} from '../domain/key-types';

/**
 * Abstract interface for key providers.
 * This allows swapping between in-memory, database, HSM, or KMS implementations.
 */
export interface IKeyProvider {
  /**
   * Generates a new keypair of the specified type
   */
  generateKeyPair(keyType: KeyType): Promise<GeneratedKeyPair>;

  /**
   * Signs data using the private key without exposing it
   *
   * @param encryptedKeyMaterial - The encrypted private key material
   * @param dataToSign - The data that needs to be signed
   * @returns Signature result
   */
  sign(
    encryptedKeyMaterial: string,
    dataToSign: Buffer,
  ): Promise<SignatureResult>;

  /**
   * Validates that a public key matches the encrypted private key
   */
  validateKeyPair(
    publicKey: string,
    encryptedKeyMaterial: string,
  ): Promise<boolean>;

  /**
   * Returns the name/type of this provider for logging
   */
  getProviderName(): string;
}
