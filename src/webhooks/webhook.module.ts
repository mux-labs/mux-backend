import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDispatchService } from './webhook-dispatch.service';
import { WebhookRetryService } from './webhook-retry.service';
import { WebhookSignerService } from './webhook-signer.service';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { WebhookEventEmitterService } from './webhook-event-emitter.service';
import { WebhookDeliveryQueueWorker } from './webhook-delivery-queue.worker';
import { WebhookController } from './webhook.controller';
import { MetricsService } from '../common/metrics/metrics.service';
import { MetricsLabelGuardService } from '../common/metrics/label-cardinality-guard';
import { WebhookConfigService } from './webhook-config.service';
import { WebhookDlqAlertService } from './webhook-dlq-alert.service';
import { CacheService } from '../common/cache/cache.service';
import { TenantScopeGuard } from '../common/guards/tenant-scope.guard';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

@Module({
  imports: [ConfigModule],
  controllers: [WebhookController],
  providers: [
    MetricsLabelGuardService,
    WebhookService,
    WebhookDispatcherService,
    WebhookDispatchService,
    WebhookRetryService,
    WebhookSignerService,
    WebhookSignatureGuard,
    WebhookEventEmitterService,
    WebhookDeliveryQueueWorker,
    MetricsService,
    WebhookConfigService,
    WebhookDlqAlertService,
    CacheService,
    TenantScopeGuard,
    FeatureFlagService,
    FeatureFlagGuard,
  ],
  exports: [WebhookEventEmitterService, WebhookDispatcherService, WebhookDlqAlertService],
})
export class WebhookModule {}
