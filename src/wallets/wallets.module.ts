import { forwardRef, Module } from '@nestjs/common';
import { WalletsService } from './wallets.service';
import { WalletsController } from './wallets.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { EncryptionService } from 'src/encryption/encryption.service';
import { ApiKeyModule } from '../api-keys/api-key.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { KeyManagementModule } from '../key-management/key-management.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { WalletRetryService } from './wallet-retry.service';
import { WalletApiMetricsService } from './wallet-api-metrics.service';

@Module({
  imports: [
    EncryptionModule,
    ApiKeyModule,
    RateLimitModule,
    KeyManagementModule,
    WebhookModule,
  ],
  controllers: [WalletsController],
  providers: [
    WalletsService,
    EncryptionService,
    WalletRetryService,
    WalletApiMetricsService,
  ],
  exports: [
    WalletsService,
    WalletRetryService,
    WalletApiMetricsService,
  ],
})
export class WalletsModule {}
