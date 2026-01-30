import { Module } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookSignerService } from './webhook-signer.service';
import { WebhookEventEmitterService } from './webhook-event-emitter.service';
import { WebhookController } from './webhook.controller';

@Module({
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookDispatcherService,
    WebhookSignerService,
    WebhookEventEmitterService,
  ],
  exports: [WebhookEventEmitterService, WebhookDispatcherService],
})
export class WebhookModule {}
