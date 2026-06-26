import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookSignerService } from './webhook-signer.service';
import { WebhookEventEmitterService } from './webhook-event-emitter.service';
import { WebhookDeliveryQueueWorker } from './webhook-delivery-queue.worker';
import { WebhookController } from './webhook.controller';
import { WebhookCacheService } from './webhook-cache.service';
import { FeatureFlagService } from '../common/services/feature-flag.service';
import { WebhooksFeatureFlagGuard } from './webhooks-feature-flag.guard';

@Module({
  imports: [ConfigModule],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookDispatcherService,
    WebhookSignerService,
    WebhookEventEmitterService,
    WebhookDeliveryQueueWorker,
    WebhookCacheService,
    FeatureFlagService,
    WebhooksFeatureFlagGuard,
  ],
  exports: [WebhookEventEmitterService, WebhookDispatcherService],
})
export class WebhookModule {}
