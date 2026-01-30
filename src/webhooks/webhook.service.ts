import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client';
import { WebhookEndpoint, EndpointStatus } from './domain/webhook-events';
import * as crypto from 'crypto';

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
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient({} as any);
  }

  /**
   * Creates a new webhook endpoint
   */
  async createEndpoint(request: CreateWebhookEndpointRequest): Promise<WebhookEndpoint> {
    this.logger.log(`Creating webhook endpoint for project ${request.projectId}`);

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

    this.logger.log(`Created webhook endpoint ${endpoint.id}`);
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
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }

    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Updates a webhook endpoint
   */
  async updateEndpoint(
    endpointId: string,
    updates: UpdateWebhookEndpointRequest
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: updates,
    });

    this.logger.log(`Updated webhook endpoint ${endpointId}`);
    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Deletes a webhook endpoint
   */
  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.prisma.webhookEndpoint.delete({
      where: { id: endpointId },
    });

    this.logger.log(`Deleted webhook endpoint ${endpointId}`);
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

    this.logger.log(`Rotated secret for webhook endpoint ${endpointId}`);
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