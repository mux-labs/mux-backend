import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEndpoint, EndpointStatus } from './domain/webhook-events';
import * as crypto from 'crypto';
import { logWebhookOperation } from './webhook-logging.util';
import { WebhookCacheService } from './webhook-cache.service';

export interface CreateWebhookEndpointRequest {
  projectId: string;
  url: string;
  events: string[];
  description?: string;
}

export interface UpdateWebhookEndpointRequest {
  url?: string;
  events?: string[];
  description?: string;
  status?: string;
}

/**
 * Webhook Management Service
 *
 * Manages webhook endpoint CRUD:
 *   POST   /webhooks/endpoints              – register endpoint
 *   GET    /webhooks/endpoints/project/:id  – list endpoints
 *   GET    /webhooks/endpoints/:id          – get endpoint
 *   PUT    /webhooks/endpoints/:id          – update endpoint
 *   DELETE /webhooks/endpoints/:id          – delete endpoint
 *   POST   /webhooks/endpoints/:id/rotate-secret
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookCache: WebhookCacheService,
  ) {}

  /**
   * Creates a new webhook endpoint
   */
  async createEndpoint(
    request: CreateWebhookEndpointRequest,
  ): Promise<WebhookEndpoint> {
    logWebhookOperation(
      this.logger,
      'log',
      `Creating webhook endpoint for project ${request.projectId}`,
      { projectId: request.projectId },
    );

    // Generate secret for signing
    const secret = this.generateSecret();

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        projectId: request.projectId,
        url: request.url,
        events: request.events,
        description: request.description,
        secret,
        status: EndpointStatus.ACTIVE,
      },
    });

    logWebhookOperation(
      this.logger,
      'log',
      `Created webhook endpoint ${endpoint.id}`,
      { endpointId: endpoint.id, projectId: request.projectId },
    );
    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Lists webhook endpoints for a project
   */
  async listEndpoints(projectId: string): Promise<WebhookEndpoint[]> {
    const endpoints = await this.prisma.webhookEndpoint.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    return endpoints.map((e) => this.mapPrismaEndpointToDomain(e));
  }

  /**
   * Gets a webhook endpoint by ID
   */
  async getEndpoint(endpointId: string): Promise<WebhookEndpoint> {
    const cacheKey = this.webhookCache.endpointKey(endpointId);
    const cached = this.webhookCache.get<WebhookEndpoint>(cacheKey);
    if (cached) {
      return cached;
    }

    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }

    const mapped = this.mapPrismaEndpointToDomain(endpoint);
    this.webhookCache.set(cacheKey, mapped);
    return mapped;
  }

  /**
   * Updates a webhook endpoint
   */
  async updateEndpoint(
    endpointId: string,
    updates: UpdateWebhookEndpointRequest,
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: updates,
    });

    this.webhookCache.invalidate(this.webhookCache.endpointKey(endpointId));
    logWebhookOperation(
      this.logger,
      'log',
      `Updated webhook endpoint ${endpointId}`,
      { endpointId },
    );
    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Deletes a webhook endpoint
   */
  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.prisma.webhookEndpoint.delete({
      where: { id: endpointId },
    });

    this.webhookCache.invalidate(this.webhookCache.endpointKey(endpointId));
    logWebhookOperation(
      this.logger,
      'log',
      `Deleted webhook endpoint ${endpointId}`,
      { endpointId },
    );
  }

  /**
   * Rotates the webhook secret
   */
  async rotateSecret(endpointId: string): Promise<{ secret: string }> {
    const newSecret = this.generateSecret();

    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { secret: newSecret },
    });

    this.webhookCache.invalidate(this.webhookCache.endpointKey(endpointId));
    logWebhookOperation(
      this.logger,
      'log',
      `Rotated secret for webhook endpoint ${endpointId}`,
      { endpointId },
    );
    return { secret: newSecret };
  }

  /**
   * Gets delivery attempts for an endpoint
   */
  async getDeliveries(endpointId: string, limit: number = 50) {
    return await this.prisma.webhookDelivery.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Generates a secure random secret
   */
  private generateSecret(): string {
    return `whsec_${crypto.randomBytes(32).toString('base64url')}`;
  }

  /**
   * Maps Prisma endpoint to domain model
   */
  private mapPrismaEndpointToDomain(prismaEndpoint: any): WebhookEndpoint {
    return {
      id: prismaEndpoint.id,
      projectId: prismaEndpoint.projectId,
      url: prismaEndpoint.url,
      description: prismaEndpoint.description,
      secret: prismaEndpoint.secret,
      events: prismaEndpoint.events,
      status: prismaEndpoint.status,
      consecutiveFailures: prismaEndpoint.consecutiveFailures,
      lastFailureAt: prismaEndpoint.lastFailureAt,
      lastFailureReason: prismaEndpoint.lastFailureReason,
      lastSuccessAt: prismaEndpoint.lastSuccessAt,
      createdAt: prismaEndpoint.createdAt,
      updatedAt: prismaEndpoint.updatedAt,
    };
  }
}
