import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Get,
  Query,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { KeyManagementService } from './key-management.service';
import type { GenerateKeyRequest, SignRequest } from './key-management.service';
import { EncryptionMigrationService } from './encryption-migration.service';
import { WalletKeyReEncryptionService } from './wallet-key-reencryption.service';
import { KeyType } from './domain/key-types';
import { KeyStatisticsQuery } from './domain/key-statistics';
import {
  KeyRotationAuditService,
  QueryAuditLogsRequest,
} from './key-rotation-audit.service';
import { KeyOperation } from '../generated/prisma/client';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';
import { InternalServiceGuard } from './guards/internal-service.guard';

function parsePaginationParam(
  value: string | undefined,
  name: string,
  max = 100,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestException(`${name} must be a non-negative integer`);
  }
  if (name === 'limit' && n > max) {
    throw new BadRequestException(`limit must not exceed ${max}`);
  }
  return n;
}

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new BadRequestException(`${name} must be a valid ISO date string`);
  }
  return d;
}

/**
 * Internal controller for key management operations
 *
 * INTERNAL-ONLY. These endpoints custody Stellar private keys and must never be
 * reachable from the public internet.
 *
 * Two independent gates protect every route:
 *  1. Feature-flag gate (`FeatureFlagGuard`): set `FEATURE_KEY_MANAGEMENT_API=true`
 *     to enable the API at all. When the flag is absent or false every endpoint
 *     returns HTTP 403.
 *  2. Internal-service gate (`InternalServiceGuard`, issue #690): callers must
 *     present the shared secret in the `x-internal-api-key` header, matched
 *     against `KEY_MANAGEMENT_INTERNAL_API_KEY`. Requests fail closed (503) when
 *     the secret is not configured and 401 when it is missing or wrong.
 *
 * These application-layer gates complement — they do not replace — network
 * policy / service-mesh restrictions that should also front this controller in
 * production.
 */
@ApiTags('internal/key-management')
@Controller('internal/key-management')
@FeatureFlag('key_management_api')
@UseGuards(FeatureFlagGuard, InternalServiceGuard)
export class KeyManagementController {
  constructor(
    private readonly keyManagementService: KeyManagementService,
    private readonly auditService: KeyRotationAuditService,
    private readonly encryptionMigrationService: EncryptionMigrationService,
    private readonly walletKeyReEncryptionService: WalletKeyReEncryptionService,
  ) {}

  /**
   * Upgrades stored ciphertext for wallets on an outdated encryption
   * envelope version (internal use only).
   */
  @ApiOperation({
    summary: 'Migrate wallets to the current encryption envelope version',
  })
  @ApiResponse({
    status: 200,
    description: 'Migration batch result: scanned, migrated, and failed counts.',
  })
  @Post('migrate-encryption-version')
  @HttpCode(HttpStatus.OK)
  async migrateEncryptionVersion(@Query('batchSize') batchSize?: string) {
    const parsedBatchSize = parsePaginationParam(batchSize, 'batchSize', 500);
    return this.encryptionMigrationService.migrateEncryptionVersions(
      parsedBatchSize,
    );
  }

  /**
   * Re-encrypts stored wallet key material after a WALLET_ENCRYPTION_KEY
   * (master key) rotation (issue #693).
   *
   * Requires `WALLET_ENCRYPTION_KEY_PREVIOUS` to be set to the prior key;
   * returns 400 otherwise. Idempotent — wallets already on the current key are
   * reported as `alreadyCurrent` and left untouched.
   */
  @ApiOperation({
    summary:
      'Re-encrypt wallet key material under the current WALLET_ENCRYPTION_KEY',
  })
  @ApiQuery({
    name: 'batchSize',
    required: false,
    description: 'Rows fetched per database page (1-1000, default 100)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Run result: scanned, reEncrypted, alreadyCurrent and failed counts.',
  })
  @ApiResponse({
    status: 400,
    description: 'WALLET_ENCRYPTION_KEY_PREVIOUS is not configured',
  })
  @Post('re-encrypt-wallet-keys')
  @HttpCode(HttpStatus.OK)
  async reEncryptWalletKeys(
    @Query('batchSize') batchSize?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    const parsedBatchSize = parsePaginationParam(batchSize, 'batchSize', 1000);
    return this.walletKeyReEncryptionService.reEncryptWallets(
      { batchSize: parsedBatchSize },
      requestId,
    );
  }

  /**
   * Generates a new key (internal use only)
   */
  @ApiOperation({ summary: 'Generate a new encrypted keypair (internal)' })
  @ApiResponse({ status: 200, description: 'Encrypted key material returned. Private key is never exposed.' })
  @ApiResponse({ status: 400, description: 'Invalid key type or request body' })
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generateKey(@Body() request: GenerateKeyRequest) {
    if (!request?.keyType) {
      throw new BadRequestException('keyType is required');
    }
    if (!Object.values(KeyType).includes(request.keyType)) {
      throw new BadRequestException(
        `Invalid keyType: "${request.keyType}". Must be one of: ${Object.values(KeyType).join(', ')}`,
      );
    }

    const result = await this.keyManagementService.generateKey(request);

    return {
      publicKey: result.publicKey,
      encryptedData: result.encryptedData,
      encryptionVersion: result.encryptionVersion,
      keyVersion: result.keyVersion,
      keyType: result.keyType,
      // Note: No private key is ever returned
    };
  }

  /**
   * Signs data without exposing private key (internal use only)
   *
   * Returns 422 if the encrypted key material cannot be decrypted.
   */
  @ApiOperation({ summary: 'Sign data using an encrypted private key (internal)' })
  @ApiResponse({ status: 200, description: 'Signature returned. Private key is never exposed.' })
  @ApiResponse({ status: 422, description: 'Key decryption failed — key material may be corrupt or encryption key changed' })
  @Post('sign')
  @HttpCode(HttpStatus.OK)
  async sign(@Body() request: SignRequest) {
    // KeyDecryptionException (422) propagates automatically through
    // NestJS HttpException handling — no try/catch needed here.
    const signature = await this.keyManagementService.sign(request);

    return {
      signature: signature.signature,
      publicKey: signature.publicKey,
      algorithm: signature.algorithm,
      timestamp: signature.timestamp,
    };
  }

  /**
   * Validates a keypair (internal use only)
   *
   * Returns 422 if the encrypted key material cannot be decrypted.
   */
  @ApiOperation({ summary: 'Validate that encrypted key material matches public key (internal)' })
  @ApiResponse({ status: 200, description: '{ valid: boolean }' })
  @ApiResponse({ status: 422, description: 'Key decryption failed' })
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validateKey(
    @Body()
    body: {
      publicKey: string;
      encryptedKeyMaterial: string;
      keyType: KeyType;
    },
  ) {
    const isValid = await this.keyManagementService.validateKey(
      body.publicKey,
      body.encryptedKeyMaterial,
      body.keyType,
    );

    return { valid: isValid };
  }

  /**
   * Rotates the key for a wallet, creating a successor and linking it.
   * The predecessor wallet is transitioned to ROTATING and its successorId is set.
   */
  @ApiOperation({ summary: 'Rotate key for a wallet — creates successor and marks predecessor ROTATING (internal)' })
  @ApiResponse({ status: 200, description: 'Rotation result with predecessor and successor wallet IDs' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({ status: 400, description: 'Wallet status does not permit rotation or already has successor' })
  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  async rotateKey(@Body() body: { walletId: string }) {
    const result = await this.keyManagementService.rotateKey(body.walletId);

    return {
      predecessorWalletId: result.predecessorWalletId,
      successorWalletId: result.successorWalletId,
      successorPublicKey: result.successorPublicKey,
    };
  }

  /**
   * Gets in-memory audit log with optional filtering and pagination
   *
   * Query parameters:
   * - operation: Filter by operation type (GENERATE, SIGN, ROTATE, etc.)
   * - publicKey: Filter by public key
   * - success: Filter by success status (true/false)
   * - startDate: Start of date range (ISO string)
   * - endDate: End of date range (ISO string)
   * - limit: Max results (default: 100, max: 100)
   * - offset: Pagination offset (default: 0)
   */
  @ApiOperation({ summary: 'Retrieve in-memory audit log (internal, admin only)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max entries to return (default: 100)' })
  @ApiResponse({ status: 200, description: 'Array of audit log entries' })
  @Get('audit')
  async getAuditLog(
    @Query('operation') operation?: string,
    @Query('publicKey') publicKey?: string,
    @Query('success') success?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: AuditLogQuery = {
      operation,
      publicKey,
      success: success !== undefined ? success === 'true' : undefined,
      startDate: parseDate(startDate, 'startDate'),
      endDate: parseDate(endDate, 'endDate'),
      limit: parsePaginationParam(limit, 'limit'),
      offset: parsePaginationParam(offset, 'offset'),
    };

    const result = this.keyManagementService.getAuditLog(query);

    return {
      logs: result.data,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
    };
  }

  /**
   * Gets key management statistics
   *
   * Query parameters:
   * - startDate: ISO date string (optional)
   * - endDate: ISO date string (optional)
   * - operation: Filter by operation type (optional)
   *
   * Example: GET /internal/key-management/statistics?startDate=2024-01-01&endDate=2024-12-31
   */
  @ApiOperation({ summary: 'Get key management operation statistics (internal)' })
  @ApiQuery({ name: 'startDate', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'endDate', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'operation', required: false, description: 'Filter by operation type' })
  @ApiResponse({ status: 200, description: 'Aggregated statistics object' })
  @Get('statistics')
  async getStatistics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('operation') operation?: string,
  ) {
    const query: KeyStatisticsQuery = {
      startDate: parseDate(startDate, 'startDate'),
      endDate: parseDate(endDate, 'endDate'),
      operation,
    };

    const statistics = this.keyManagementService.getStatistics(query);

    return {
      success: true,
      data: statistics,
    };
  }

  /**
   * Gets detailed key management statistics with metrics and time series
   *
   * Query parameters:
   * - startDate: ISO date string (optional)
   * - endDate: ISO date string (optional)
   * - operation: Filter by operation type (optional)
   * - includeTimeSeries: Include hourly time series data (optional, default: false)
   *
   * Example: GET /internal/key-management/statistics/detailed?includeTimeSeries=true
   */
  @ApiOperation({ summary: 'Get detailed key management statistics with per-operation metrics (internal)' })
  @ApiQuery({ name: 'includeTimeSeries', required: false, description: 'Include hourly time series (default: false)' })
  @ApiResponse({ status: 200, description: 'Detailed statistics with operation metrics' })
  @Get('statistics/detailed')
  async getDetailedStatistics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('operation') operation?: string,
    @Query('includeTimeSeries') includeTimeSeries?: string,
  ) {
    const query: KeyStatisticsQuery = {
      startDate: parseDate(startDate, 'startDate'),
      endDate: parseDate(endDate, 'endDate'),
      operation,
      includeTimeSeries: includeTimeSeries === 'true',
    };

    const statistics = this.keyManagementService.getDetailedStatistics(query);

    return {
      success: true,
      data: statistics,
    };
  }

  /**
   * Queries persistent audit logs with filtering
   *
   * Query parameters:
   * - operation: Filter by operation type (GENERATE, SIGN, ROTATE, etc.)
   * - keyId: Filter by key ID
   * - publicKey: Filter by public key
   * - startDate: Start of date range (ISO string)
   * - endDate: End of date range (ISO string)
   * - success: Filter by success status (true/false)
   * - limit: Max results to return (default: 100)
   * - offset: Pagination offset (default: 0)
   *
   * Example: GET /internal/key-management/audit/persistent?operation=ROTATE&limit=50
   */
  @ApiOperation({ summary: 'Query persistent (database-backed) audit logs with filtering (internal)' })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries from database' })
  @Get('audit/persistent')
  async getPersistentAuditLogs(
    @Query('operation') operation?: string,
    @Query('keyId') keyId?: string,
    @Query('publicKey') publicKey?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('success') success?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const query: QueryAuditLogsRequest = {
      operation: operation as KeyOperation | undefined,
      keyId,
      publicKey,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      success: success !== undefined ? success === 'true' : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    };

    const result = await this.auditService.queryAuditLogs(query);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Gets complete rotation history for a specific key
   *
   * GET /internal/key-management/audit/rotation-history/:keyId
   */
  @ApiOperation({ summary: 'Get full rotation chain history for a key (internal)' })
  @ApiParam({ name: 'keyId', description: 'Wallet or key ID to trace rotation history for' })
  @ApiResponse({ status: 200, description: 'Ordered list of rotation audit entries' })
  @Get('audit/rotation-history/:keyId')
  async getRotationHistory(@Param('keyId') keyId: string) {
    const result = await this.auditService.getRotationHistory(keyId);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * Gets audit log statistics
   *
   * Query parameters:
   * - startDate: Start of date range (ISO string)
   * - endDate: End of date range (ISO string)
   *
   * Example: GET /internal/key-management/audit/statistics?startDate=2024-01-01
   */
  @ApiOperation({ summary: 'Get audit log statistics over a date range (internal)' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'Aggregated audit statistics' })
  @Get('audit/statistics')
  async getAuditStatistics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const stats = await this.auditService.getAuditStatistics(
      startDate ? new Date(startDate) : undefined,
      endDate ? new Date(endDate) : undefined,
    );

    return {
      success: true,
      data: stats,
    };
  }
}
