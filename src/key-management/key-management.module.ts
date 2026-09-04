import { Module } from '@nestjs/common';
import { makeCounterProvider, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { KeyManagementService } from './key-management.service';
import { KeyManagementController } from './key-management.controller';
import { StellarKeyProvider } from './providers/stellar-key.provider';
import { EncryptionModule } from '../encryption/encryption.module';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { PrismaModule } from '../prisma/prisma.module';
import { KeyManagementMetricsService } from './key-management-metrics.service';
import { EncryptionMigrationService } from './encryption-migration.service';
import { WalletKeyReEncryptionService } from './wallet-key-reencryption.service';

@Module({
  imports: [EncryptionModule, PrismaModule, EventEmitterModule.forRoot()],
  controllers: [KeyManagementController],
  providers: [
    KeyManagementService,
    StellarKeyProvider,
    KeyRotationAuditService,
    KeyManagementMetricsService,
    EncryptionMigrationService,
    WalletKeyReEncryptionService,
    makeCounterProvider({
      name: 'key_mgmt_operations_total',
      help: 'Total number of key management operations by type and status',
      labelNames: ['operation', 'status'],
    }),
    makeHistogramProvider({
      name: 'key_mgmt_operation_duration_ms',
      help: 'Duration of key management operations in milliseconds',
      labelNames: ['operation'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    }),
  ],
  exports: [KeyManagementService, KeyRotationAuditService, KeyValidationCacheService],
})
export class KeyManagementModule {}
