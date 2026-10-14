import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDlqAlertService } from './webhook-dlq-alert.service';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { UpdateWebhookEndpointDto } from './dto/update-webhook-endpoint.dto';
import { WebhookFilterDto } from './dto/webhook-filter.dto';
import { UpdateWebhookSubscriptionsDto } from './dto/update-webhook-subscriptions.dto';
import { WebhookEventType } from './domain/webhook-events';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';
import { FeatureFlag } from '../common/feature-flags/feature-flag.guard';
import {
  TenantScopeGuard,
  TenantScoped,
} from '../common/guards/tenant-scope.guard';
import { WebhookSignatureGuard } from './webhook-signature.guard';

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(FeatureFlagGuard, TenantScopeGuard)
@FeatureFlag('webhooks_enabled')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly dlqAlertService: WebhookDlqAlertService,
  ) {}

  // ---------------------------------------------------------------------------
  // POST /webhooks/endpoints
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: 'Register a new webhook endpoint' })
  @ApiBody({
    type: CreateWebhookEndpointDto,
    examples: {
      default: {
        value: {
          projectId: 'project-uuid',
          url: 'https://example.com/webhook',
          events: ['wallet.created', 'transaction.confirmed'],
          description: 'My webhook endpoint',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'Webhook endpoint created. Secret is only returned on creation.',
    example: {
      id: 'endpoint-uuid',
      url: 'https://example.com/webhook',
      events: ['wallet.created', 'transaction.confirmed'],
      description: 'My webhook endpoint',
      secret: 'whsec_abc123...',
      status: 'ACTIVE',
      createdAt: '2024-06-24T12:00:00.000Z',
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — invalid input',
    example: {
      statusCode: 400,
      message: ['url must be a valid URL', 'events must not be empty'],
      error: 'Bad Request',
    },
  })
  @Post('endpoints')
  @HttpCode(HttpStatus.CREATED)
  async createEndpoint(@Body() request: CreateWebhookEndpointDto) {
    const endpoint = await this.webhookService.createEndpoint(request);

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      description: endpoint.description,
      secret: endpoint.secret,
      status: endpoint.status,
      createdAt: endpoint.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/endpoints/project/:projectId
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: 'List webhook endpoints for a project' })
  @ApiParam({
    name: 'projectId',
    description: 'Project ID',
    example: 'project-uuid',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number (starting from 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 20,
    description: 'Items per page (max 100)',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'DISABLED', 'FAILED'],
    description: 'Filter by endpoint status',
  })
  @ApiQuery({
    name: 'event',
    required: false,
    example: 'wallet.created',
    description: 'Filter by subscribed event type',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of webhook endpoints',
    example: {
      endpoints: [
        {
          id: 'endpoint-uuid',
          url: 'https://example.com/webhook',
          events: ['wallet.created'],
          description: 'My webhook',
          status: 'ACTIVE',
          consecutiveFailures: 0,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastFailureReason: null,
          createdAt: '2024-06-24T12:00:00.000Z',
          updatedAt: '2024-06-24T12:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    },
  })
  @Get('endpoints/project/:projectId')
  @TenantScoped('projectId')
  async listEndpoints(
    @Param('projectId') projectId: string,
    @Query() filter: WebhookFilterDto,
  ) {
    const result = await this.webhookService.listEndpoints(projectId, filter);

    return {
      page: result.page,
      limit: result.limit,
      total: result.total,
      endpoints: result.endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        events: e.events,
        description: e.description,
        status: e.status,
        consecutiveFailures: e.consecutiveFailures,
        lastSuccessAt: e.lastSuccessAt,
        lastFailureAt: e.lastFailureAt,
        lastFailureReason: e.lastFailureReason,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/endpoints/:id
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: 'Get a specific webhook endpoint' })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook endpoint details (secret is never returned here)',
    example: {
      id: 'endpoint-uuid',
      url: 'https://example.com/webhook',
      events: ['wallet.created', 'transaction.confirmed'],
      description: 'My webhook endpoint',
      status: 'ACTIVE',
      consecutiveFailures: 0,
      lastSuccessAt: '2024-06-24T13:00:00.000Z',
      lastFailureAt: null,
      lastFailureReason: null,
      createdAt: '2024-06-24T12:00:00.000Z',
      updatedAt: '2024-06-24T13:00:00.000Z',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
    example: {
      statusCode: 404,
      message: 'Webhook endpoint not found',
      error: 'Not Found',
    },
  })
  @Get('endpoints/:id')
  async getEndpoint(@Param('id') id: string) {
    const endpoint = await this.webhookService.getEndpoint(id);

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      description: endpoint.description,
      status: endpoint.status,
      consecutiveFailures: endpoint.consecutiveFailures,
      lastSuccessAt: endpoint.lastSuccessAt,
      lastFailureAt: endpoint.lastFailureAt,
      lastFailureReason: endpoint.lastFailureReason,
      createdAt: endpoint.createdAt,
      updatedAt: endpoint.updatedAt,
      // Note: secret is never returned on GET
    };
  }

  // ---------------------------------------------------------------------------
  // PUT /webhooks/endpoints/:id
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: 'Update a webhook endpoint' })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiBody({
    type: UpdateWebhookEndpointDto,
    examples: {
      updateUrl: {
        summary: 'Change URL and subscribed events',
        value: {
          url: 'https://example.com/new-webhook',
          events: ['wallet.created', 'balance.updated'],
        },
      },
      disable: {
        summary: 'Disable the endpoint',
        value: {
          status: 'DISABLED',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Endpoint updated successfully',
    example: {
      id: 'endpoint-uuid',
      url: 'https://example.com/new-webhook',
      events: ['wallet.created', 'balance.updated'],
      description: 'My webhook endpoint',
      status: 'ACTIVE',
      updatedAt: '2024-06-24T14:00:00.000Z',
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — invalid input',
    example: {
      statusCode: 400,
      message: ['url must be a valid URL'],
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
    example: {
      statusCode: 404,
      message: 'Webhook endpoint not found',
      error: 'Not Found',
    },
  })
  @Put('endpoints/:id')
  @HttpCode(HttpStatus.OK)
  async updateEndpoint(
    @Param('id') id: string,
    @Body() updates: UpdateWebhookEndpointDto,
  ) {
    const endpoint = await this.webhookService.updateEndpoint(id, updates);

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      description: endpoint.description,
      status: endpoint.status,
      updatedAt: endpoint.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // DELETE /webhooks/endpoints/:id
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: 'Delete a webhook endpoint' })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiResponse({
    status: 204,
    description: 'Endpoint deleted successfully (no body returned)',
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
    example: {
      statusCode: 404,
      message: 'Webhook endpoint not found',
      error: 'Not Found',
    },
  })
  @Delete('endpoints/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEndpoint(@Param('id') id: string) {
    await this.webhookService.deleteEndpoint(id);
  }

  // ---------------------------------------------------------------------------
  // POST /webhooks/endpoints/:id/rotate-secret
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Rotate the webhook signing secret',
    description:
      'Generates a new HMAC-SHA256 signing secret for the endpoint. ' +
      'The new secret is **only returned once** in this response — store it immediately.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiResponse({
    status: 200,
    description:
      'New secret returned. This is the only time it will be visible.',
    example: {
      secret: 'whsec_newSecretValue123...',
      rotatedAt: '2024-06-24T15:00:00.000Z',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
    example: {
      statusCode: 404,
      message: 'Webhook endpoint not found',
      error: 'Not Found',
    },
  })
  @Post('endpoints/:id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  async rotateSecret(@Param('id') id: string) {
    const result = await this.webhookService.rotateSecret(id);

    return {
      secret: result.secret, // Only time the new secret is returned!
      rotatedAt: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/endpoints/:id/deliveries
  // ---------------------------------------------------------------------------

  @ApiOperation({ summary: 'Get delivery history for a webhook endpoint' })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    example: 1,
    description: 'Page number (starting from 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    example: 50,
    description: 'Items per page (max 100)',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated delivery history',
    example: {
      endpointId: 'endpoint-uuid',
      page: 1,
      limit: 50,
      total: 3,
      deliveries: [
        {
          id: 'delivery-uuid',
          eventId: 'event-uuid',
          eventType: 'wallet.created',
          status: 'DELIVERED',
          attempts: 1,
          maxAttempts: 5,
          responseStatus: 200,
          responseTime: 142,
          nextRetryAt: null,
          firstAttemptAt: '2024-06-24T12:01:00.000Z',
          lastAttemptAt: '2024-06-24T12:01:00.000Z',
          deliveredAt: '2024-06-24T12:01:00.000Z',
          errorMessage: null,
          createdAt: '2024-06-24T12:00:00.000Z',
        },
      ],
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
    example: {
      statusCode: 404,
      message: 'Webhook endpoint not found',
      error: 'Not Found',
    },
  })
  @Get('endpoints/:id/deliveries')
  async getDeliveries(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNumber = Math.max(1, parseInt(page || '1', 10));
    const pageLimit = Math.min(100, Math.max(1, parseInt(limit || '50', 10)));

    const result = await this.webhookService.getDeliveries(
      id,
      pageNumber,
      pageLimit,
    );

    return {
      endpointId: id,
      page: pageNumber,
      limit: pageLimit,
      total: result.total,
      deliveries: result.deliveries.map((d) => ({
        id: d.id,
        eventId: d.eventId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        maxAttempts: d.maxAttempts,
        responseStatus: d.responseStatus,
        responseTime: d.responseTime,
        nextRetryAt: d.nextRetryAt,
        firstAttemptAt: d.firstAttemptAt,
        lastAttemptAt: d.lastAttemptAt,
        deliveredAt: d.deliveredAt,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * Lists dead-lettered deliveries (exhausted all retries)
   */
  @Get('deliveries/dead-letter')
  async getDeadLetters(
    @Query('projectId') projectId?: string,
    @Query('endpointId') endpointId?: string,
    @Query('limit') limit?: string,
  ) {
    const deadLetters = await this.webhookService.getDeadLetters({
      projectId,
      endpointId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });

    return {
      deadLetters: deadLetters.map((d) => ({
        id: d.id,
        endpointId: d.endpointId,
        endpointUrl: (d as any).endpoint?.url,
        eventId: d.eventId,
        eventType: d.eventType,
        attempts: d.attempts,
        maxAttempts: d.maxAttempts,
        responseStatus: d.responseStatus,
        errorMessage: d.errorMessage,
        firstAttemptAt: d.firstAttemptAt,
        lastAttemptAt: d.lastAttemptAt,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * Requeues a dead-lettered delivery and immediately attempts redelivery
   */
  @Post('deliveries/:id/replay')
  @HttpCode(HttpStatus.OK)
  async replayDeadLetter(@Param('id') id: string) {
    await this.webhookService.replayDeadLetter(id);
    const result = await this.webhookDispatcher.processDeliveries();

    return {
      replayed: id,
      processed: result.delivered + result.failed + result.retrying,
      delivered: result.delivered,
      failed: result.failed,
      retrying: result.retrying,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/endpoints/:id/subscriptions
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Get subscribed event types for a webhook endpoint',
    description:
      'Returns the list of event types the endpoint is currently subscribed to, ' +
      'along with a reference of all valid event types.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiResponse({
    status: 200,
    description: 'Current event subscriptions',
    schema: {
      example: {
        endpointId: 'endpoint-uuid',
        events: ['wallet.created', 'transaction.confirmed'],
        allValidEvents: [
          'wallet.created',
          'wallet.activated',
          'transaction.confirmed',
        ],
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
    example: { statusCode: 404, message: 'Webhook endpoint endpoint-uuid not found' },
  })
  @Get('endpoints/:id/subscriptions')
  async getSubscribedEvents(@Param('id') id: string) {
    const events = await this.webhookService.getSubscribedEvents(id);
    return {
      endpointId: id,
      events,
      allValidEvents: Object.values(WebhookEventType),
    };
  }

  // ---------------------------------------------------------------------------
  // PUT /webhooks/endpoints/:id/subscriptions
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Replace subscribed event types for a webhook endpoint',
    description:
      'Replaces all subscribed event types with the supplied list. ' +
      'All values must be members of the known WebhookEventType enum. ' +
      'Providing an unknown event type returns 400 Bad Request.',
  })
  @ApiParam({
    name: 'id',
    description: 'Webhook endpoint ID',
    example: 'endpoint-uuid',
  })
  @ApiBody({
    type: UpdateWebhookSubscriptionsDto,
    examples: {
      default: {
        value: {
          events: ['wallet.created', 'transaction.confirmed'],
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Updated event subscriptions',
    schema: {
      example: {
        endpointId: 'endpoint-uuid',
        events: ['wallet.created', 'transaction.confirmed'],
        updatedAt: '2026-07-30T00:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'One or more event types are not valid WebhookEventType values',
    example: {
      statusCode: 400,
      message: 'Unknown event type(s): foo.bar. Valid values: wallet.created, ...',
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Endpoint not found',
  })
  @Put('endpoints/:id/subscriptions')
  @HttpCode(HttpStatus.OK)
  async updateSubscribedEvents(
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionsDto,
  ) {
    const events = await this.webhookService.updateSubscribedEvents(id, dto.events);
    return {
      endpointId: id,
      events,
      updatedAt: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/event-types  — reference list of all valid event types
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'List all valid webhook event types',
    description:
      'Returns the complete set of event type strings that can be used ' +
      'when creating or updating webhook endpoint subscriptions.',
  })
  @ApiResponse({
    status: 200,
    description: 'Enum of all supported event types',
    schema: {
      example: {
        eventTypes: [
          'wallet.created',
          'wallet.activated',
          'wallet.suspended',
          'wallet.rotated',
          'transaction.created',
          'transaction.pending',
          'transaction.confirmed',
          'transaction.failed',
          'balance.updated',
          'balance.low',
          'balance.mismatch',
          'user.created',
          'user.updated',
          'auth.user_authenticated',
          'auth.new_user_registered',
          'auth.authentication_failed',
        ],
      },
    },
  })
  @Get('event-types')
  listEventTypes() {
    return {
      eventTypes: Object.values(WebhookEventType),
    };
  }

  /**
   * Manually triggers webhook delivery processing (admin only)
   */
  // ---------------------------------------------------------------------------
  // POST /webhooks/process-deliveries
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Manually trigger webhook delivery processing (admin)',
    description:
      'Picks up all pending and retrying webhook deliveries and attempts to dispatch them. ' +
      'Intended for admin use or recovery from processing backlogs.',
  })
  @ApiResponse({
    status: 200,
    description: 'Processing complete — summary of delivery outcomes',
    example: {
      processed: 5,
      delivered: 3,
      failed: 1,
      retrying: 1,
    },
  })
  @Post('process-deliveries')
  @HttpCode(HttpStatus.OK)
  async processDeliveries() {
    const result = await this.webhookDispatcher.processDeliveries();

    return {
      processed: result.delivered + result.failed + result.retrying,
      delivered: result.delivered,
      failed: result.failed,
      retrying: result.retrying,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/dlq/status  — DLQ depth + alert check (admin)
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Check DLQ depth and evaluate alert thresholds (admin)',
    description:
      'Returns the current dead-letter queue depth, percentage of failed deliveries, ' +
      'age of the oldest item, and whether any alert thresholds have been breached. ' +
      'This also triggers an immediate threshold evaluation identical to the background poller.',
  })
  @ApiResponse({
    status: 200,
    description: 'DLQ status with alert information',
    schema: {
      example: {
        dlqDepth: 3,
        totalDeliveries: 120,
        dlqPercentage: 2.5,
        oldestDlqItemAgeMs: 450000,
        thresholdBreached: false,
        alerts: [],
        checkedAt: '2026-07-27T05:00:00.000Z',
        thresholds: {
          absoluteThreshold: 50,
          percentageThreshold: 10,
          ageThresholdMs: 3600000,
        },
      },
    },
  })
  @Get('dlq/status')
  async getDlqStatus() {
    const [status, thresholds] = await Promise.all([
      this.dlqAlertService.checkDlqDepth(),
      Promise.resolve(this.dlqAlertService.getThresholds()),
    ]);

    return {
      dlqDepth: status.dlqDepth,
      totalDeliveries: status.totalDeliveries,
      dlqPercentage: Number(status.dlqPercentage.toFixed(4)),
      oldestDlqItemAgeMs: status.oldestDlqItemAgeMs,
      thresholdBreached: status.thresholdBreached,
      alerts: status.alerts,
      checkedAt: status.checkedAt,
      thresholds,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /webhooks/dlq/depth  — lightweight depth-only probe
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Get current DLQ depth (lightweight probe)',
    description:
      'Returns only the count of dead-lettered deliveries without triggering ' +
      'the full alert evaluation. Suitable for health probes and dashboards.',
  })
  @ApiResponse({
    status: 200,
    description: 'DLQ depth metrics',
    schema: {
      example: {
        depth: 3,
        total: 120,
        percentage: 2.5,
      },
    },
  })
  @Get('dlq/depth')
  async getDlqDepth() {
    return this.dlqAlertService.getDlqDepth();
  }

  // ---------------------------------------------------------------------------
  // POST /webhooks/inbound
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Receive inbound webhook',
    description:
      'Receives and verifies an inbound webhook notification signed with HMAC-SHA256.',
  })
  @ApiResponse({
    status: 200,
    description: 'Webhook received and processed successfully',
    schema: {
      example: {
        received: true,
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  @UseGuards(WebhookSignatureGuard)
  @Post('inbound')
  @HttpCode(HttpStatus.OK)
  async receiveInboundWebhook(@Body() body: unknown) {
    return {
      received: true,
    };
  }
}
