import { Module } from '@nestjs/common';
import { WebhookSignatureService } from './webhook-signature.service';
import { MetricsService } from '../common/metrics/metrics.service';

/**
 * Webhook signature verification.
 *
 * The service is deliberately free of any delivery/registration surface: it
 * verifies a `t=..,v1=..` header against a secret, so it can be shared by an
 * inbound receiver, a partner relay, or a test harness without dragging in
 * endpoint CRUD. Consumers must supply the secret explicitly — there is no
 * ambient secret lookup, so a caller cannot accidentally verify against a
 * default.
 */
@Module({
  providers: [WebhookSignatureService, MetricsService],
  exports: [WebhookSignatureService],
})
export class WebhooksModule {}
