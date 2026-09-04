import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { IKeyProvider } from './interfaces/key-provider.interface';
import { StellarKeyProvider } from './providers/stellar-key.provider';
import {
  EncryptionService,
  DecryptionError,
} from '../encryption/encryption.service';
import { SafeLogger } from '../common/safe-logger';
import { PrismaService } from '../prisma/prisma.service';
import { KeyDecryptionException } from './exceptions/key-decryption.exception';
import { KeyManagementMetricsService } from './key-management-metrics.service';
import { retryWithBackoff } from './utils/retry.util';
import {
  GeneratedKeyPair,
  SignatureResult,
  KeyType,
  EncryptedKeyMaterial,
  KeyOperationAudit,
} from './domain/key-types';
import {
  KeyStatistics,
  KeyStatisticsQuery,
  DetailedKeyStatistics,
  KeyOperationMetrics,
} from './domain/key-statistics';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { KeyGeneratedEvent } from './events/key-generated.event';
import { KeySignedEvent } from './events/key-signed.event';
import { KeyRotatedEvent } from './events/key-rotated.event';
import { KeyValidatedEvent } from './events/key-validated.event';

export interface GenerateKeyRequest {
  keyType: KeyType;
  metadata?: Record<string, any>;
}

export interface SignRequest {
  encryptedKeyMaterial: string;
  dataToSign: Buffer | string;
  publicKey: string; // For audit trail
}

export interface RotateKeyResult {
  /** The newly created successor wallet ID */
  successorWalletId: string;
  /** The new wallet's public key */
  successorPublicKey: string;
  /** The key algorithm/derivation scheme version of the successor */
  successorKeyVersion: number;
  /** The predecessor wallet ID (now marked ROTATING with successorId set) */
  predecessorWalletId: string;
}

export interface AuditLogQuery {
  operation?: string;
  publicKey?: string;
  success?: boolean;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditLogResult {
  data: KeyOperationAudit[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
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
  private readonly logger = new SafeLogger(KeyManagementService.name);
  private readonly providers: Map<KeyType, IKeyProvider>;
  private readonly auditLog: KeyOperationAudit[] = [];

  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;

  constructor(
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditService: KeyRotationAuditService,
    private readonly metricsService: KeyManagementMetricsService,
  ) {
    this.maxRetries = this.configService.get<number>('KEY_MGMT_MAX_RETRIES', 3);
    this.retryBackoffMs = this.configService.get<number>('KEY_MGMT_RETRY_BACKOFF_MS', 200);
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
    if (!request.keyType || !Object.values(KeyType).includes(request.keyType)) {
      throw new BadRequestException(
        `Invalid keyType: "${request.keyType}". Must be one of: ${Object.values(KeyType).join(', ')}`,
      );
    }

    const startTime = Date.now();

    try {
      const provider = this.getProvider(request.keyType);

      const keyPair = await retryWithBackoff(
        () => provider.generateKeyPair(request.keyType),
        {
          maxAttempts: this.maxRetries,
          initialDelayMs: this.retryBackoffMs,
        },
      );

      // CRITICAL: Encrypt immediately, never store plaintext
      const encryptedData = this.encryptionService.encryptAndSerialize(
        keyPair.privateKeyMaterial,
      );

      const duration = Date.now() - startTime;
      this.metricsService.incrementKeyOperations('GENERATE', 'success');
      this.metricsService.recordKeyOperationDuration('GENERATE', duration);

      // Audit log (no sensitive data)
      this.auditKeyOperation({
        operation: 'GENERATE',
        keyId: 'new',
        publicKey: keyPair.publicKey,
        timestamp: new Date(),
        success: true,
        metadata: request.metadata,
      });

      this.logger.log(
        `Generated ${request.keyType} key in ${duration}ms (publicKey: ${keyPair.publicKey.substring(0, 12)}...)`,
      );

      return {
        encryptedData,
        encryptionVersion: 1,
        keyVersion: 1,
        keyType: request.keyType,
        publicKey: keyPair.publicKey,
      };
    } catch (error) {
      this.metricsService.incrementKeyOperations('GENERATE', 'failure');
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
   *
   * @throws KeyDecryptionException if the encrypted key material cannot be decrypted
   */
  async sign(request: SignRequest): Promise<SignatureResult> {
    if (!request.encryptedKeyMaterial) {
      throw new BadRequestException('encryptedKeyMaterial is required');
    }
    if (!request.publicKey) {
      throw new BadRequestException('publicKey is required');
    }
    if (!request.dataToSign) {
      throw new BadRequestException('dataToSign is required');
    }

    const startTime = Date.now();

    const keyType = KeyType.STELLAR_ED25519;
    const provider = this.getProvider(keyType);

    try {
      const dataToSign =
        typeof request.dataToSign === 'string'
          ? Buffer.from(request.dataToSign, 'utf8')
          : request.dataToSign;

      // Sign the data (private key is decrypted temporarily inside provider)
      const signature = await retryWithBackoff(
        () => provider.sign(request.encryptedKeyMaterial, dataToSign),
        {
          maxAttempts: this.maxRetries,
          initialDelayMs: this.retryBackoffMs,
          shouldRetry: (err) => !(err instanceof DecryptionError),
        },
      );

      const duration = Date.now() - startTime;
      this.metricsService.incrementKeyOperations('SIGN', 'success');
      this.metricsService.recordKeyOperationDuration('SIGN', duration);

      // Audit log (no sensitive data)
      this.auditKeyOperation({
        operation: 'SIGN',
        keyId: 'unknown',
        publicKey: request.publicKey,
        timestamp: new Date(),
        success: true,
      });

      this.logger.log(
        `Signed data in ${duration}ms (publicKey: ${request.publicKey.substring(0, 12)}...)`,
      );

      return signature;
    } catch (error) {
      // Handle decrypt failures — log and convert to typed HTTP exception
      if (error instanceof DecryptionError) {
        this.metricsService.incrementKeyOperations('SIGN', 'failure');
        this.auditKeyOperation({
          operation: 'SIGN',
          keyId: 'unknown',
          publicKey: request.publicKey,
          timestamp: new Date(),
          success: false,
          errorMessage: `decrypt_failure:${error.code}`,
        });

        this.logger.error(
          `Key decryption failed during sign for publicKey=${request.publicKey.substring(0, 12)}...:`,
          { code: error.code },
        );

        throw new KeyDecryptionException(
          request.publicKey,
          error.code,
          'Key material could not be decrypted — the key may be corrupted or the encryption key may have changed',
        );
      }

      this.metricsService.incrementKeyOperations('SIGN', 'failure');
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
   *
   * @throws KeyDecryptionException if the key material cannot be decrypted
   */
  async validateKey(
    publicKey: string,
    encryptedKeyMaterial: string,
    keyType: KeyType,
  ): Promise<boolean> {
    if (!publicKey) {
      throw new BadRequestException('publicKey is required');
    }
    if (!encryptedKeyMaterial) {
      throw new BadRequestException('encryptedKeyMaterial is required');
    }
    if (!keyType || !Object.values(KeyType).includes(keyType)) {
      throw new BadRequestException(
        `Invalid keyType: "${keyType}". Must be one of: ${Object.values(KeyType).join(', ')}`,
      );
    }

    const provider = this.getProvider(keyType);

    try {
      const valid = await provider.validateKeyPair(publicKey, encryptedKeyMaterial);

      this.eventEmitter.emit(
        'key.validated',
        new KeyValidatedEvent(publicKey, keyType, valid, new Date()),
      );

      return valid;
    } catch (error) {
      if (error instanceof DecryptionError) {
        this.logger.error(
          `Key decryption failed during validate for publicKey=${publicKey.substring(0, 12)}...:`,
          { code: error.code },
        );
        throw new KeyDecryptionException(publicKey, error.code);
      }

      this.logger.error('Key validation failed:', error);
      return false;
    }
  }

  /**
   * Re-encrypts key material (for key rotation or encryption version upgrade)
   *
   * @throws KeyDecryptionException if the existing key material cannot be decrypted
   */
  async reEncryptKey(
    encryptedKeyMaterial: string,
    keyType: KeyType,
    keyId: string = 'unknown',
  ): Promise<EncryptedKeyMaterial> {
    try {
      // Decrypt with current encryption key
      const privateKeyMaterial =
        this.encryptionService.deserializeAndDecrypt(encryptedKeyMaterial);

      // Re-encrypt with current encryption (might be new version)
      const newEncryptedData =
        this.encryptionService.encryptAndSerialize(privateKeyMaterial);

      this.logger.log(
        `Successfully re-encrypted key material for key ${keyId}`,
      );

      return {
        encryptedData: newEncryptedData,
        encryptionVersion: 2, // Increment encryption envelope version
        keyVersion: 1,
        keyType,
        publicKey: '', // Would derive from private key in production
      };
    } catch (error) {
      if (error instanceof DecryptionError) {
        this.logger.error(
          `Key decryption failed during re-encrypt for key ${keyId}:`,
          { code: error.code },
        );
        throw new KeyDecryptionException(
          keyId,
          error.code,
          'Cannot re-encrypt key material — decryption failed',
        );
      }

      this.logger.error('Key re-encryption failed:', error);
      throw new Error('Key re-encryption failed');
    }
  }

  /**
   * Rotates the key for a wallet by creating a successor wallet and linking it.
   *
   * Steps:
   * 1. Verify the predecessor wallet exists and is ACTIVE or ROTATING.
   * 2. Generate a new keypair and encrypt it.
   * 3. Create the successor wallet record (ACTIVE) with rotatedFromId set.
   * 4. Set successorId on the predecessor and transition it to ROTATING.
   *
   * All DB writes are wrapped in a transaction to prevent partial state.
   */
  async rotateKey(predecessorWalletId: string): Promise<RotateKeyResult> {
    const predecessor = await this.prisma.wallet.findUnique({
      where: { id: predecessorWalletId },
    });

    if (!predecessor) {
      throw new NotFoundException(`Wallet ${predecessorWalletId} not found`);
    }

    if (!['ACTIVE', 'ROTATING'].includes(predecessor.status)) {
      throw new Error(`Cannot rotate wallet in status: ${predecessor.status}`);
    }

    if (predecessor.successorId) {
      throw new Error(
        `Wallet ${predecessorWalletId} already has a successor: ${predecessor.successorId}`,
      );
    }

    // Generate new keypair
    const keyMaterial = await this.generateKey({
      keyType: KeyType.STELLAR_ED25519,
      metadata: { rotatedFromId: predecessorWalletId },
    });

    const [successor] = await this.prisma.$transaction(async (tx) => {
      // Create successor wallet
      const newWallet = await tx.wallet.create({
        data: {
          userId: predecessor.userId,
          publicKey: keyMaterial.publicKey,
          encryptedSecret: keyMaterial.encryptedData,
          encryptionVersion: keyMaterial.encryptionVersion,
          keyVersion: keyMaterial.keyVersion,
          secretVersion: predecessor.secretVersion + 1,
          network: predecessor.network,
          status: 'ACTIVE',
          rotatedFromId: predecessorWalletId,
        },
      });

      // Link successor on predecessor and mark it ROTATING
      await tx.wallet.update({
        where: { id: predecessorWalletId },
        data: {
          successorId: newWallet.id,
          status: 'ROTATING',
          statusReason: 'Key rotation initiated',
          statusChangedAt: new Date(),
        },
      });

      return [newWallet];
    });

    this.metricsService.incrementKeyOperations('ROTATE', 'success');
    this.auditKeyOperation({
      operation: 'ROTATE',
      keyId: predecessorWalletId,
      publicKey: keyMaterial.publicKey,
      timestamp: new Date(),
      success: true,
      metadata: { successorWalletId: successor.id },
    });

    this.eventEmitter.emit(
      'key.rotated',
      new KeyRotatedEvent(
        predecessorWalletId,
        successor.id,
        successor.publicKey,
        new Date(),
      ),
    );

    this.logger.log(
      `Rotated key for wallet ${predecessorWalletId} -> successor ${successor.id}`,
    );

    return {
      successorWalletId: successor.id,
      successorPublicKey: successor.publicKey,
      successorKeyVersion: successor.keyVersion,
      predecessorWalletId,
    };
  }

  /**
   * Returns filtered and paginated in-memory audit log
   */
  getAuditLog(query?: AuditLogQuery): AuditLogResult {
    const limit = query?.limit ?? 100;
    const offset = query?.offset ?? 0;

    let filtered = [...this.auditLog];

    if (query?.operation) {
      filtered = filtered.filter((log) => log.operation === query.operation);
    }
    if (query?.publicKey) {
      filtered = filtered.filter((log) => log.publicKey === query.publicKey);
    }
    if (query?.success !== undefined) {
      filtered = filtered.filter((log) => log.success === query.success);
    }
    if (query?.startDate) {
      filtered = filtered.filter((log) => log.timestamp >= query.startDate!);
    }
    if (query?.endDate) {
      filtered = filtered.filter((log) => log.timestamp <= query.endDate!);
    }

    const total = filtered.length;
    const data = filtered.slice(offset, offset + limit);

    return { data, total, limit, offset, hasMore: offset + data.length < total };
  }

  /**
   * Returns key generation and usage statistics
   */
  getStatistics(query?: KeyStatisticsQuery): KeyStatistics {
    const startDate = query?.startDate || new Date(0);
    const endDate = query?.endDate || new Date();

    // Filter audit log by date range and query parameters
    const filteredLogs = this.auditLog.filter((log) => {
      const inDateRange =
        log.timestamp >= startDate && log.timestamp <= endDate;
      const matchesOperation = query?.operation
        ? log.operation === query.operation
        : true;

      return inDateRange && matchesOperation;
    });

    // Calculate statistics
    const totalKeysGenerated = filteredLogs.filter(
      (log) => log.operation === 'GENERATE',
    ).length;
    const totalSigningOperations = filteredLogs.filter(
      (log) => log.operation === 'SIGN',
    ).length;
    const totalValidations = filteredLogs.filter(
      (log) => log.operation === 'ACCESS',
    ).length;
    const totalFailures = filteredLogs.filter((log) => !log.success).length;

    // Count keys by type (from metadata)
    const keysByType: Record<string, number> = {};
    filteredLogs
      .filter((log) => log.operation === 'GENERATE')
      .forEach((log) => {
        const keyType = log.metadata?.keyType || 'unknown';
        keysByType[keyType] = (keysByType[keyType] || 0) + 1;
      });

    // Count operations by type
    const operationsByType: Record<string, number> = {};
    filteredLogs.forEach((log) => {
      operationsByType[log.operation] =
        (operationsByType[log.operation] || 0) + 1;
    });

    // Calculate success rate
    const totalOperations = filteredLogs.length;
    const successRate =
      totalOperations > 0
        ? ((totalOperations - totalFailures) / totalOperations) * 100
        : 100;

    // Find last operation
    const lastOperation =
      filteredLogs.length > 0
        ? filteredLogs[filteredLogs.length - 1].timestamp
        : undefined;

    return {
      totalKeysGenerated,
      totalSigningOperations,
      totalValidations,
      totalFailures,
      keysByType,
      operationsByType,
      successRate,
      lastOperation,
      periodStart: startDate,
      periodEnd: endDate,
    };
  }

  /**
   * Returns detailed statistics with operation metrics and time series
   */
  getDetailedStatistics(query?: KeyStatisticsQuery): DetailedKeyStatistics {
    const basicStats = this.getStatistics(query);
    const startDate = query?.startDate || new Date(0);
    const endDate = query?.endDate || new Date();

    // Filter logs for detailed analysis
    const filteredLogs = this.auditLog.filter((log) => {
      return log.timestamp >= startDate && log.timestamp <= endDate;
    });

    // Calculate operation metrics
    const operationTypes = new Set(filteredLogs.map((log) => log.operation));
    const operationMetrics: KeyOperationMetrics[] = [];

    operationTypes.forEach((operation) => {
      const logs = filteredLogs.filter((log) => log.operation === operation);
      const successCount = logs.filter((log) => log.success).length;
      const failureCount = logs.filter((log) => !log.success).length;
      const count = logs.length;

      operationMetrics.push({
        operation,
        count,
        successCount,
        failureCount,
        successRate: count > 0 ? (successCount / count) * 100 : 100,
      });
    });

    // Get recent operations (last 10)
    const recentOperations = filteredLogs
      .slice(-10)
      .reverse()
      .map((log) => ({
        operation: log.operation,
        timestamp: log.timestamp,
        success: log.success,
        keyType: log.metadata?.keyType as string | undefined,
      }));

    const result: DetailedKeyStatistics = {
      ...basicStats,
      operationMetrics,
      recentOperations,
    };

    // Add time series if requested
    if (query?.includeTimeSeries) {
      result.timeSeries = this.generateTimeSeries(
        filteredLogs,
        startDate,
        endDate,
      );
    }

    return result;
  }

  /**
   * Generates time series data from audit logs
   */
  private generateTimeSeries(
    logs: KeyOperationAudit[],
    startDate: Date,
    endDate: Date,
  ) {
    // Group by hour for the time range
    const hourlyData = new Map<string, Map<string, number>>();

    logs.forEach((log) => {
      const hourKey = new Date(log.timestamp).toISOString().substring(0, 13); // YYYY-MM-DDTHH

      if (!hourlyData.has(hourKey)) {
        hourlyData.set(hourKey, new Map());
      }

      const operationCount = hourlyData.get(hourKey)!;
      operationCount.set(
        log.operation,
        (operationCount.get(log.operation) || 0) + 1,
      );
    });

    // Convert to array format
    const timeSeries: Array<{
      timestamp: Date;
      count: number;
      operation: string;
    }> = [];

    hourlyData.forEach((operations, hourKey) => {
      operations.forEach((count, operation) => {
        timeSeries.push({
          timestamp: new Date(hourKey + ':00:00.000Z'),
          count,
          operation,
        });
      });
    });

    return timeSeries.sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }

  /**
   * Resets statistics (for testing or manual reset)
   */
  resetStatistics(): void {
    this.auditLog.length = 0;
    this.logger.warn('Key management statistics have been reset');
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
   * Automatically propagates the current request ID from RequestContextService.
   */
  private auditKeyOperation(audit: KeyOperationAudit): void {
    const enriched: KeyOperationAudit = {
      ...audit,
      requestId: audit.requestId ?? this.requestContext.getRequestId(),
    };

    this.auditLog.push(enriched);

    // Persist to database for compliance and long-term retention
    this.auditService
      .persistAuditLog(
        this.auditService.convertToPersistentFormat(enriched, {
          retentionDays: 365,
        }),
      )
      .catch((error) => {
        this.logger.error(
          'Audit persistence failed (non-blocking):',
          error.message,
        );
      });

    const reqTag = enriched.requestId ? ` req=${enriched.requestId}` : '';
    this.logger.log(
      `[AUDIT] ${enriched.operation} - ${enriched.publicKey.substring(0, 12)}... - ` +
        `${enriched.success ? 'SUCCESS' : 'FAILED'}` +
        (enriched.errorMessage ? ` - ${enriched.errorMessage}` : '') +
        reqTag,
    );

    // Keep only last 1000 audit entries in memory
    if (this.auditLog.length > 1000) {
      this.auditLog.shift();
    }
  }
}
