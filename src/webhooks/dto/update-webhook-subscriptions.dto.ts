import { IsArray, ArrayNotEmpty, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { WebhookEventType } from '../domain/webhook-events';

/**
 * DTO for replacing the full set of subscribed event types on a webhook endpoint.
 */
export class UpdateWebhookSubscriptionsDto {
  @ApiProperty({
    description:
      'Complete list of event types to subscribe to. Replaces all existing subscriptions.',
    example: ['wallet.created', 'transaction.confirmed'],
    enum: WebhookEventType,
    isArray: true,
  })
  @IsArray({ message: 'events must be an array' })
  @ArrayNotEmpty({ message: 'events must not be empty' })
  @IsEnum(WebhookEventType, {
    each: true,
    message: `each event must be a valid WebhookEventType. Valid values: ${Object.values(WebhookEventType).join(', ')}`,
  })
  events: WebhookEventType[];
}
