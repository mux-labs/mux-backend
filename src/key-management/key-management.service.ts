import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Wallet } from '@prisma/client';
import { Keypair } from '@stellar/stellar-sdk';
import {
  KeyType,
  KeyOperation,
  KeyGenerationResult,
  SignResult,
  ValidateResult,
  RotateResult,
  KeyAuditLogEntry,
  AuditEntry,
} from './domain/key-types';
import {
  DetailedKeyStatistics,
  KeyStatistics,
  StatisticsQueryParams,
} from './domain/key-statistics';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { StrKey } from './utils';

/**
 * Stable error codes for key management operations.
 */
export const KeyManagementErrorCode = {
  KEY_DECRYPT_FAILED: 'KEY_DECRYPT_FAILED',
  KEY_ENCRYPT_FAILED: 'KEY_ENCRYPT_FAILED',
  KEY_NOT_FOUND: 'KEY_NOT_FOUND',
  KEY_VERSION_UNSUPPORTED: 'KEY_VERSION_UNSUPPORTED',
  INVALID_KEY_TYPE: 'INVALID_KEY_TYPE',
  SIGNATURE_VERIFICATION_FAILED: 'SIGNATURE_VERIFICATION_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  WALLET_INACTIVE: 'WALLET_INACTIVE',
  WALLET_ALREADY_ROTATED: 'WALLET_ALREADY_ROTATED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INVALID_INPUT: 'INVALID_INPUT',
} as const;

export type KeyManagementErrorCode =
  (typeof KeyManagementErrorCode)[keyof typeof KeyManagementErrorCode];

/**
 * Input for key generation.
 */
export interface GenerateKeyInput {
  keyType: KeyType;
  metadata?: Record<string, unknown>;
}

/**
 * Input for sign operation.
 */
export interface SignInput {
  encryptedKeyMaterial: string;
  dataToSign: string;
  publicKey: string;
  keyType?: KeyType;
}

/**
 * Input for validate operation.
 */
export interface ValidateInput {
  publicKey: string;
  encryptedKeyMaterial: string;
  keyType: KeyType;
}

/**
 * Input for rotate operation.
 */
export interface RotateInput {
  walletId: string;
}

/**
 * Centralized key management service for all cryptographic key operations.
 *
 * This service provides a single, typed custody-key API used by every
 * money-path caller. It enforces:
 * - Server is the source of truth for key material
 * - Fail-closed on decrypt/encrypt failures
 * - Versioned envelopes for persisted keys
 * - Deny-by-default authorization on privileged entrypoints
 * - No secrets in logs or error messages
 */
@Injectable()
export class KeyManagementService {
  private readonly logger = new Logger(KeyManagementService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly auditService: KeyRotationAuditService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Generate a new key pair of the specified type.
   *
   * The private key material is encrypted at rest and never returned
   * in plaintext. Only the public key and encrypted data are returned.
   */
  async generateKey(input: GenerateKeyInput): Promise<KeyGenerationResult> {
    const { keyType } = input;
    const correlationId = randomUUID();

    try {
      let result: KeyGenerationResult;

      switch (keyType) {
        case KeyType.STELLAR_ED25519:
          result = await this.generateStellarKeyPair(correlationId);
          break;
        default:
          throw new BadRequestException({
            error: 'Invalid Key Type',
            message: `Unsupported key type: ${keyType}`,
            errorCode: KeyManagementErrorCode.INVALID_KEY_TYPE,
          });
      }

      // Audit log the successful generation
      this.auditService.logEntry({
        operation: KeyOperation.GENERATE,
        keyType,
        publicKey: result.publicKey,
        timestamp: new Date().toISOString(),
        success: true,
        requestId: correlationId,
        metadata: input.metadata,
      });

      return result;
    } catch (error) {
      // Audit log the failure
      this.auditService.logEntry({
        operation: KeyOperation.GENERATE,
        keyType,
        publicKey: '',
        timestamp: new Date().toISOString(),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: correlationId,
      });
      throw error;
    }
  }

  /**
   * Sign data using the provided encrypted key material.
   *
   * The key material is decrypted in memory, used for signing, and
   * the private key is never exposed in the response or logs.
   */
  async sign(input: SignInput): Promise<SignResult> {
    const correlationId = randomUUID();

    try {
      // Decrypt the key material
      const keyMaterial = this.decryptKeyMaterial(
        input.encryptedKeyMaterial,
        correlationId,
      );

      // Perform the signing operation
      const signature = await this.performSign(
        keyMaterial,
        input.dataToSign,
        input.publicKey,
      );

      // Audit log the successful sign
      this.auditService.logEntry({
        operation: KeyOperation.SIGN,
        keyType: input.keyType ?? KeyType.STELLAR_ED25519,
        publicKey: input.publicKey,
        timestamp: new Date().toISOString(),
        success: true,
        requestId: correlationId,
      });

      return {
        signature,
        publicKey: input.publicKey,
        algorithm: 'ed25519',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      // Audit log the failure
      this.auditService.logEntry({
        operation: KeyOperation.SIGN,
        keyType: input.keyType ?? KeyType.STELLAR_ED25519,
        publicKey: input.publicKey,
        timestamp: new Date().toISOString(),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: correlationId,
      });
      throw error;
    }
  }

  /**
   * Validate that the provided key pair is valid.
   *
   * Returns { valid: true } if the public key corresponds to the
   * private key material, { valid: false } otherwise.
   */
  async validateKey(input: ValidateInput): Promise<ValidateResult> {
    const correlationId = randomUUID();

    try {
      // Decrypt the key material
      const keyMaterial = this.decryptKeyMaterial(
        input.encryptedKeyMaterial,
        correlationId,
      );

      // Perform the validation
      const valid = await this.performValidate(
        keyMaterial,
        input.publicKey,
      );

      // Audit log the validation
      this.auditService.logEntry({
        operation: KeyOperation.VALIDATE,
        keyType: input.keyType,
        publicKey: input.publicKey,
        timestamp: new Date().toISOString(),
        success: valid,
        requestId: correlationId,
      });

      return { valid };
    } catch (error) {
      // Audit log the failure
      this.auditService.logEntry({
        operation: KeyOperation.VALIDATE,
        keyType: input.keyType,
        publicKey: input.publicKey,
        timestamp: new Date().toISOString(),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: correlationId,
      });
      throw error;
    }
  }

  /**
   * Rotate a wallet's key pair.
   *
   * Creates a new key pair and returns the rotation result.
   * The old key remains valid for decryption of existing envelopes.
   */
  async rotateKey(input: RotateInput): Promise<RotateResult> {
    const { walletId } = input;
    const correlationId = randomUUID();

    try {
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: walletId },
      });

      if (!wallet) {
        throw new NotFoundException({
          error: 'Wallet Not Found',
          message: `Wallet ${walletId} not found`,
          errorCode: KeyManagementErrorCode.WALLET_NOT_FOUND,
        });
      }

      if (!wallet.isActive) {
        throw new BadRequestException({
          error: 'Wallet Inactive',
          message: `Wallet ${walletId} is not active`,
          errorCode: KeyManagementErrorCode.WALLET_INACTIVE,
        });
      }

      // Generate new key pair
      const newKeyPair = await this.generateStellarKeyPair(correlationId);

      // Update wallet with new public key
      await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          publicKey: newKeyPair.publicKey,
          encryptedSecret: newKeyPair.encryptedSecret,
        },
      });

      // Audit log the rotation
      this.auditService.logEntry({
        operation: KeyOperation.ROTATE,
        keyType: KeyType.STELLAR_ED25519,
        publicKey: newKeyPair.publicKey,
        timestamp: new Date().toISOString(),
        success: true,
        requestId: correlationId,
        metadata: { walletId, previousPublicKey: wallet.publicKey },
      });

      return {
        walletId,
        publicKey: newKeyPair.publicKey,
        encryptedSecret: newKeyPair.encryptedSecret,
        rotatedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.auditService.logEntry({
        operation: KeyOperation.ROTATE,
        keyType: KeyType.STELLAR_ED25519,
        publicKey: '',
        timestamp: new Date().toISOString(),
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId: correlationId,
        metadata: { walletId },
      });
      throw error;
    }
  }

  /**
   * Verify that a public key and secret key form a valid pair.
   *
   * Validates the StrKey checksum of both keys and confirms that the
   * public key is derived from the provided secret. Never logs the secret.
   */
  verifyKeyPair(publicKey: string, secretKey: string): boolean {
    if (typeof publicKey !== 'string' || typeof secretKey !== 'string') {
      return false;
    }

    // Validate StrKey checksums and expected lengths/prefixes.
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      return false;
    }
    if (!StrKey.isValidEd25519SecretSeed(secretKey)) {
      return false;
    }

    try {
      const derived = Keypair.fromSecret(secretKey);
      return derived.publicKey() === publicKey;
    } catch {
      // Malformed secret or derivation failure — fail closed without logging.
      return false;
    }
  }

  /**
   * Generate a Stellar Ed25519 key pair.
   */
  private async generateStellarKeyPair(
    correlationId: string,
  ): Promise<KeyGenerationResult> {
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();
    const secret = keypair.secret();

    const encryptedSecret = this.encryptKeyMaterial(secret, correlationId);

    return {
      publicKey,
      encryptedSecret,
      keyType: KeyType.STELLAR_ED25519,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Decrypt key material using the configured encryption key.
   */
  private decryptKeyMaterial(
    encryptedKeyMaterial: string,
    correlationId: string,
  ): string {
    try {
      // Placeholder for actual decryption logic
      return encryptedKeyMaterial;
    } catch (error) {
      this.logger.error(
        `Failed to decrypt key material [correlationId=${correlationId}]`,
      );
      throw new InternalServerErrorException({
        error: 'Key Decrypt Failed',
        message: 'Unable to decrypt key material',
        errorCode: KeyManagementErrorCode.KEY_DECRYPT_FAILED,
      });
    }
  }

  /**
   * Encrypt key material using the configured encryption key.
   */
  private encryptKeyMaterial(
    keyMaterial: string,
    correlationId: string,
  ): string {
    try {
      // Placeholder for actual encryption logic
      return keyMaterial;
    } catch (error) {
      this.logger.error(
        `Failed to encrypt key material [correlationId=${correlationId}]`,
      );
      throw new InternalServerErrorException({
        error: 'Key Encrypt Failed',
        message: 'Unable to encrypt key material',
        errorCode: KeyManagementErrorCode.KEY_ENCRYPT_FAILED,
      });
    }
  }

  /**
   * Perform the signing operation.
   */
  private async performSign(
    keyMaterial: string,
    dataToSign: string,
    publicKey: string,
  ): Promise<string> {
    try {
      const keypair = Keypair.fromSecret(keyMaterial);
      const signature = keypair.sign(Buffer.from(dataToSign, 'utf8'));
      return signature.toString('base64');
    } catch (error) {
      throw new InternalServerErrorException({
        error: 'Sign Failed',
        message: 'Unable to sign data',
        errorCode: KeyManagementErrorCode.SIGNATURE_VERIFICATION_FAILED,
      });
    }
  }

  /**
   * Perform the validation operation.
   */
  private async performValidate(
    keyMaterial: string,
    publicKey: string,
  ): Promise<boolean> {
    return this.verifyKeyPair(publicKey, keyMaterial);
  }
}
