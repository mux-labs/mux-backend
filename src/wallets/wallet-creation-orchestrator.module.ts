import { forwardRef, Module } from '@nestjs/common';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { WalletCleanupSchedulerService } from './wallet-cleanup-scheduler.service';
import { WalletCreationOrchestratorController } from './wallet-creation-orchestrator.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WalletsModule } from './wallets.module';
import { UsersModule } from '../users/users.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { KeyManagementModule } from '../key-management/key-management.module';
import { CacheService } from '../common/cache/cache.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    KeyManagementModule,
    forwardRef(() => WalletsModule),
    UsersModule,
    WebhookModule,
  ],
  controllers: [WalletCreationOrchestratorController],
  providers: [
    WalletCreationOrchestrator,
    WalletCleanupSchedulerService,
    IdempotencyService,
    CacheService,
    FeatureFlagService,
    FeatureFlagGuard,
  ],
  exports: [WalletCreationOrchestrator],
})
export class WalletCreationOrchestratorModule {}
