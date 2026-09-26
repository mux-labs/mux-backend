import { Module } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { KeyManagementController } from './key-management.controller';
import { KeyRotationAuditService } from './key-rotation-audit.service';

/**
 * Key Management Module
 *
 * Centralizes all cryptographic key operations (generate, sign, validate,
 * rotate) and provides key management statistics endpoints.
 *
 * This module is internal-only and should not be exposed to the public
 * internet. All endpoints are under /internal/key-management/* and
 * must be protected by authentication/authorization guards.
 *
 * @see {@link https://github.com/mux-labs/mux-backend/blob/main/docs/KEY-STATISTICS-FEATURE.md}
 */
@Module({
  controllers: [KeyManagementController],
  providers: [KeyManagementService, KeyRotationAuditService],
  exports: [KeyManagementService],
})
export class KeyManagementModule {}