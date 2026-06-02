import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  KeyManagementService,
  GenerateKeyRequest,
  SignRequest,
} from './key-management.service';
import { KeyType } from './domain/key-types';
import { KeyDecryptionException } from './exceptions/key-decryption.exception';

/**
 * Internal controller for key management operations
 *
 * WARNING: This should be internal-only and NOT exposed to public APIs.
 * All endpoints should be protected by network policy or a separate internal
 * API key guard before reaching production.
 */
@Controller('internal/key-management')
export class KeyManagementController {
  private readonly logger = new Logger(KeyManagementController.name);

  constructor(private readonly keyManagementService: KeyManagementService) {}

  /**
   * Generates a new key (internal use only)
   */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generateKey(@Body() request: GenerateKeyRequest) {
    const result = await this.keyManagementService.generateKey(request);

    return {
      publicKey: result.publicKey,
      encryptedData: result.encryptedData,
      encryptionVersion: result.encryptionVersion,
      keyType: result.keyType,
      // Note: No private key is ever returned
    };
  }

  /**
   * Signs data without exposing private key (internal use only)
   *
   * Returns 422 if the encrypted key material cannot be decrypted.
   */
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
   * Re-encrypts key material under the current encryption key (internal use only)
   *
   * Use this endpoint during encryption key rotation to migrate stored key
   * material to the new key without generating a new keypair.
   *
   * Returns 422 if the existing key material cannot be decrypted (stale or
   * corrupt data should be investigated before retrying).
   */
  @Post('re-encrypt')
  @HttpCode(HttpStatus.OK)
  async reEncryptKey(
    @Body()
    body: {
      encryptedKeyMaterial: string;
      keyType: KeyType;
      keyId?: string;
    },
  ) {
    const result = await this.keyManagementService.reEncryptKey(
      body.encryptedKeyMaterial,
      body.keyType,
      body.keyId,
    );

    return {
      encryptedData: result.encryptedData,
      encryptionVersion: result.encryptionVersion,
      keyType: result.keyType,
    };
  }

  /**
   * Gets audit log (admin only)
   */
  @Get('audit')
  async getAuditLog(@Query('limit') limit?: string) {
    const auditLimit = limit ? parseInt(limit, 10) : 100;
    const logs = this.keyManagementService.getAuditLog(auditLimit);

    return { logs };
  }
}
