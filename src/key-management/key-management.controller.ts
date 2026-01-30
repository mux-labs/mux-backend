import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  KeyManagementService,
  GenerateKeyRequest,
  SignRequest,
} from './key-management.service';
import { KeyType } from './domain/key-types';

/**
 * Internal controller for key management operations
 *
 * WARNING: This should be internal-only and NOT exposed to public APIs
 */
@Controller('internal/key-management')
export class KeyManagementController {
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
   */
  @Post('sign')
  @HttpCode(HttpStatus.OK)
  async sign(@Body() request: SignRequest) {
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
   * Gets audit log (admin only)
   */
  @Get('audit')
  async getAuditLog(@Query('limit') limit?: string) {
    const auditLimit = limit ? parseInt(limit, 10) : 100;
    const logs = this.keyManagementService.getAuditLog(auditLimit);

    return { logs };
  }
}
