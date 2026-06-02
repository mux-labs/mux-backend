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
} from '@nestjs/common';
import {
  WebhookService,
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
} from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly webhookService: WebhookService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  /**
   * Creates a new webhook endpoint
   */
  @Post('endpoints')
  @HttpCode(HttpStatus.CREATED)
  async createEndpoint(@Body() request: CreateWebhookEndpointRequest) {
    const endpoint = await this.webhookService.createEndpoint(request);

    return {
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      description: endpoint.description,
      secret: endpoint.secret, // Only returned on creation!
      status: endpoint.status,
      createdAt: endpoint.createdAt,
    };
  }

  /**
   * Lists webhook endpoints for a project
   */
  @Get('endpoints/project/:projectId')
  async listEndpoints(@Param('projectId') projectId: string) {
    const endpoints = await this.webhookService.listEndpoints(projectId);

    // Don't return secrets in list
    return {
      endpoints: endpoints.map((e) => ({
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

  /**
   * Gets a specific webhook endpoint
   */
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
      // Note: Secret not returned in GET
    };
  }

  /**
   * Updates a webhook endpoint
   */
  @Put('endpoints/:id')
  @HttpCode(HttpStatus.OK)
  async updateEndpoint(
    @Param('id') id: string,
    @Body() updates: UpdateWebhookEndpointRequest,
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

  /**
   * Deletes a webhook endpoint
   */
  @Delete('endpoints/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteEndpoint(@Param('id') id: string) {
    await this.webhookService.deleteEndpoint(id);
  }

  /**
   * Rotates the webhook signing secret
   */
  @Post('endpoints/:id/rotate-secret')
  @HttpCode(HttpStatus.OK)
  async rotateSecret(@Param('id') id: string) {
    const result = await this.webhookService.rotateSecret(id);

    return {
      secret: result.secret, // Only time new secret is returned!
      rotatedAt: new Date(),
    };
  }

  /**
   * Gets delivery history for an endpoint
   */
  @Get('endpoints/:id/deliveries')
  async getDeliveries(@Param('id') id: string, @Query('limit') limit?: string) {
    const deliveryLimit = limit ? parseInt(limit, 10) : 50;
    const deliveries = await this.webhookService.getDeliveries(
      id,
      deliveryLimit,
    );

    return {
      endpointId: id,
      deliveries: deliveries.map((d) => ({
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
   * Manually triggers webhook delivery processing (admin only)
   */
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
}
