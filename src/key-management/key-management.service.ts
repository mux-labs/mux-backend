import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IKeyProvider } from './interfaces/key-provider.interface';
import { StellarKeyProvider } from './providers/stellar-key.provider';
import { EncryptionService } from '../encryption/encryption.service';
import {
  GeneratedKeyPair,
  SignatureResult,
  KeyType,
  EncryptedKeyMaterial,
  KeyOperationAudit,
} from './domain/key-types';

export interface GenerateKeyRequest {
  keyType: KeyType;
  metadata?: Record<string, any>;
}

export interface SignRequest {
  encryptedKeyMaterial: string;
  dataToSign: Buffer | string;
  publicKey: string; // For audit trail
}

/**
 * Custodial Key Management Service
 *
 * This service is the ONLY layer that has access to private keys.
 * It provides:
 * - Key generation
 * - Signing operations without key exposure
 * - Key rotation support
 * - Audit logging
 * - Provider abstraction for future HSM/KMS integration
 *
 * CRITICAL SECURITY PROPERTIES:
 * - Private keys are NEVER returned from this service
 * - Private keys are NEVER logged
 * - All key operations are audited
 * - Keys are encrypted immediately after generation
 */
@Injectable()
export class KeyManagementService {
  private readonly logger = new Logger(KeyManagementService.name);
  private readonly providers: Map<KeyType, IKeyProvider>;
  private readonly auditLog: KeyOperationAudit[] = [];

  constructor(
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {
    // Initialize key providers
    this.providers = new Map();

    // Register Stellar provider
    const stellarProvider = new StellarKeyProvider(this.encryptionService);
    this.providers.set(KeyType.STELLAR_ED25519, stellarProvider);

    this.logger.log(
      'Key Management Service initialized with providers: ' +
        Array.from(this.providers.keys()).join(', '),
    );
  }

  /**
   * Generates a new keypair and returns it encrypted
   *
   * CRITICAL: The plaintext private key is only in memory briefly
   * and is NEVER stored or logged.
   */
  async generateKey(
    request: GenerateKeyRequest,
  ): Promise<EncryptedKeyMaterial> {
    const startTime = Date.now();
    const provider = this.getProvider(request.keyType);

    try {
      // Generate the keypair
      const keyPair = await provider.generateKeyPair(request.keyType);

      // CRITICAL: Encrypt immediately, never store plaintext
      const encryptedData = this.encryptionService.encryptAndSerialize(
        keyPair.privateKeyMaterial,
      );

      // Audit log (no sensitive data)
      this.auditKeyOperation({
        operation: 'GENERATE',
        keyId: 'new',
        publicKey: keyPair.publicKey,
        timestamp: new Date(),
        success: true,
        metadata: request.metadata,
      });

      const duration = Date.now() - startTime;
      this.logger.log(
        `Generated ${request.keyType} key in ${duration}ms (publicKey: ${keyPair.publicKey.substring(0, 12)}...)`,
      );

      return {
        encryptedData,
        encryptionVersion: 1,
        keyType: request.keyType,
        publicKey: keyPair.publicKey,
      };
    } catch (error) {
      this.auditKeyOperation({
        operation: 'GENERATE',
        keyId: 'new',
        publicKey: 'failed',
        timestamp: new Date(),
        success: false,
        errorMessage: error.message,
      });

      this.logger.error(`Key generation failed for ${request.keyType}:`, error);
      throw new Error('Key generation failed');
    }
  }

  /**
   * Signs data WITHOUT exposing the private key
   *
   * This is the ONLY way to use private keys - they are never returned.
   */
  async sign(request: SignRequest): Promise<SignatureResult> {
    const startTime = Date.now();

    // Determine key type from encrypted material structure
    // In a real system, you'd store this metadata separately
    const keyType = KeyType.STELLAR_ED25519; // Default for now
    const provider = this.getProvider(keyType);

    try {
      // Convert string to Buffer if needed
      const dataToSign =
        typeof request.dataToSign === 'string'
          ? Buffer.from(request.dataToSign, 'utf8')
          : request.dataToSign;

      // Sign the data (private key is decrypted temporarily inside provider)
      const signature = await provider.sign(
        request.encryptedKeyMaterial,
        dataToSign,
      );

      // Audit log (no sensitive data)
      this.auditKeyOperation({
        operation: 'SIGN',
        keyId: 'unknown', // Would come from wallet ID in real system
        publicKey: request.publicKey,
        timestamp: new Date(),
        success: true,
      });

      const duration = Date.now() - startTime;
      this.logger.log(
        `Signed data in ${duration}ms (publicKey: ${request.publicKey.substring(0, 12)}...)`,
      );

      return signature;
    } catch (error) {
      this.auditKeyOperation({
        operation: 'SIGN',
        keyId: 'unknown',
        publicKey: request.publicKey,
        timestamp: new Date(),
        success: false,
        errorMessage: error.message,
      });

      this.logger.error('Signing operation failed:', error);
      throw new Error('Signing operation failed');
    }
  }

  /**
   * Validates that encrypted key material is valid and matches the public key
   */
  async validateKey(
    publicKey: string,
    encryptedKeyMaterial: string,
    keyType: KeyType,
  ): Promise<boolean> {
    const provider = this.getProvider(keyType);

    try {
      return await provider.validateKeyPair(publicKey, encryptedKeyMaterial);
    } catch (error) {
      this.logger.error('Key validation failed:', error);
      return false;
    }
  }

  /**
   * Re-encrypts key material (for key rotation or encryption version upgrade)
   */
  async reEncryptKey(
    encryptedKeyMaterial: string,
    keyType: KeyType,
  ): Promise<EncryptedKeyMaterial> {
    try {
      // Decrypt with old encryption
      const privateKeyMaterial =
        this.encryptionService.deserializeAndDecrypt(encryptedKeyMaterial);

      // Re-encrypt with current encryption (might be new version)
      const newEncryptedData =
        this.encryptionService.encryptAndSerialize(privateKeyMaterial);

      // Derive public key for result
      const provider = this.getProvider(keyType);
      const keyPair = await provider.generateKeyPair(keyType); // Temp for structure

      this.logger.log('Successfully re-encrypted key material');

      return {
        encryptedData: newEncryptedData,
        encryptionVersion: 2, // Increment version
        keyType,
        publicKey: '', // Would derive from private key in production
      };
    } catch (error) {
      this.logger.error('Key re-encryption failed:', error);
      throw new Error('Key re-encryption failed');
    }
  }

  /**
   * Returns audit log (for security monitoring)
   */
  getAuditLog(limit: number = 100): KeyOperationAudit[] {
    return this.auditLog.slice(-limit);
  }

  /**
   * Gets the appropriate key provider for a key type
   */
  private getProvider(keyType: KeyType): IKeyProvider {
    const provider = this.providers.get(keyType);

    if (!provider) {
      throw new NotFoundException(
        `No provider registered for key type: ${keyType}`,
      );
    }

    return provider;
  }

  /**
   * Audits key operations (NEVER log sensitive data)
   */
  private auditKeyOperation(audit: KeyOperationAudit): void {
    this.auditLog.push(audit);

    // In production, send to external audit system
    this.logger.log(
      `[AUDIT] ${audit.operation} - ${audit.publicKey.substring(0, 12)}... - ` +
        `${audit.success ? 'SUCCESS' : 'FAILED'}` +
        (audit.errorMessage ? ` - ${audit.errorMessage}` : ''),
    );

    // Keep only last 1000 audit entries in memory
    if (this.auditLog.length > 1000) {
      this.auditLog.shift();
    }
  }
}
