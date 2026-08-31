import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import {
  WebhookEndpoint,
  WebhookEventType,
  EndpointStatus,
  DeliveryStatus,
} from './domain/webhook-events';
import { SafeLogger } from '../common/safe-logger';
import { WebhookFilterDto } from './dto/webhook-filter.dto';
import { WebhookSecretService } from './webhook-secret.service';
import { MetricsService } from '../common/metrics/metrics.service';
import * as crypto from 'crypto';

export const WEBHOOK_CACHE_TTL = 60_000;
export const WEBHOOK_ENDPOINT_CACHE_PREFIX = 'webhook:endpoint:';
export const WEBHOOK_SECRET_GRACE_DEFAULT_SECONDS = 3_600;

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

export interface PaginatedEndpointsResponse {
  endpoints: WebhookEndpoint[];
  total: number;
  page: number;
  limit: number;
}

export interface PaginatedDeliveriesResponse {
  deliveries: any[];
  total: number;
  page: number;
  limit: number;
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
 *
 * Signing secrets are NEVER persisted in plaintext. Each endpoint's secret
 * is derived deterministically from WEBHOOK_SIGNING_KEY (see
 * {@link WebhookSecretService}) and only its SHA-256 hash is stored, exactly
 * like API keys. Rotation stages a new secret version that becomes active
 * only after a configurable grace window (WEBHOOK_SECRET_GRACE_SECONDS), so
 * consumers still verifying with the previous secret are not cut off — no
 * downtime.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new SafeLogger(WebhookService.name);
  private readonly secretGraceSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly secretService: WebhookSecretService,
    private readonly configService: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.secretGraceSeconds = this.configService.get<number>(
      'WEBHOOK_SECRET_GRACE_SECONDS',
      WEBHOOK_SECRET_GRACE_DEFAULT_SECONDS,
    );
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  /**
   * Creates a new webhook endpoint.
   *
   * Generates the endpoint id up front so the signing secret can be derived
   * deterministically. The plaintext secret is returned exactly once — callers
   * must store it immediately. Only `sha256(secret)` is persisted.
   */
  async createEndpoint(
    request: CreateWebhookEndpointRequest,
  ): Promise<WebhookEndpoint & { secret: string }> {
    const endpointId = crypto.randomUUID();
    const secret = this.secretService.deriveSecret(endpointId, 1);

    const endpoint = await this.prisma.webhookEndpoint.create({
      data: {
        id: endpointId,
        projectId: request.projectId,
        url: request.url,
        events: request.events,
        description: request.description,
        secretVersion: 1,
        secretHash: this.secretService.hashSecret(secret),
        status: EndpointStatus.ACTIVE,
      },
    });

    this.logger.log(`Created webhook endpoint ${endpoint.id}`);

    return {
      ...this.mapPrismaEndpointToDomain(endpoint),
      secret, // Only returned once, at creation.
    };
  }

  /**
   * Lists webhook endpoints for a project, with optional status/event
   * filters and pagination.
   */
  async listEndpoints(
    projectId: string,
    filterOrPage?: WebhookFilterDto | number,
    limit?: number,
  ): Promise<{
    endpoints: WebhookEndpoint[];
    total: number;
    page: number;
    limit: number;
  }> {
    let page = 1;
    let take = 20;
    let statusFilter: string | undefined;
    let eventFilter: string | undefined;

    if (typeof filterOrPage === 'object' && filterOrPage !== null) {
      const filter = filterOrPage as WebhookFilterDto;
      page = filter.page ?? 1;
      take = filter.limit ?? 20;
      statusFilter = filter.status;
      eventFilter = filter.event;
    } else if (typeof filterOrPage === 'number') {
      page = filterOrPage;
      take = limit ?? 20;
    }

    const skip = (page - 1) * take;

    const where: Record<string, unknown> = { projectId };
    if (statusFilter) {
      where.status = statusFilter;
    }
    if (eventFilter) {
      where.events = { has: eventFilter };
    }

    const [endpoints, total] = await Promise.all([
      this.prisma.webhookEndpoint.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.webhookEndpoint.count({ where }),
    ]);

    return {
      endpoints: endpoints.map((e) => this.mapPrismaEndpointToDomain(e)),
      total,
      page,
      limit: take,
    };
  }

  /**
   * Gets a webhook endpoint by ID, serving from cache when available.
   */
  async getEndpoint(endpointId: string): Promise<WebhookEndpoint> {
    const cacheKey = `${WEBHOOK_ENDPOINT_CACHE_PREFIX}${endpointId}`;
    const cached = this.cache.get<WebhookEndpoint>(cacheKey);
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
    this.cache.set(cacheKey, mapped, WEBHOOK_CACHE_TTL);

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

    this.invalidateEndpointCache(endpointId);

    return this.mapPrismaEndpointToDomain(endpoint);
  }

  /**
   * Deletes a webhook endpoint
   */
  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.prisma.webhookEndpoint.delete({
      where: { id: endpointId },
    });

    this.invalidateEndpointCache(endpointId);
  }

  /**
   * Returns the list of event types the endpoint is currently subscribed to.
   */
  async getSubscribedEvents(endpointId: string): Promise<string[]> {
    const endpoint = await this.getEndpoint(endpointId);
    return endpoint.events;
  }

  /**
   * Replaces all subscribed event types for the endpoint.
   * Validates each event against the known WebhookEventType enum before persisting.
   *
   * @param endpointId  The endpoint to update.
   * @param events      The complete replacement set of event type strings.
   * @returns           The persisted list of event types.
   */
  async updateSubscribedEvents(
    endpointId: string,
    events: string[],
  ): Promise<string[]> {
    const validValues = new Set<string>(Object.values(WebhookEventType));
    const invalid = events.filter((e) => !validValues.has(e));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unknown event type(s): ${invalid.join(', ')}. ` +
          `Valid values: ${[...validValues].join(', ')}`,
      );
    }

    // Verify the endpoint exists (throws NotFoundException if not found)
    await this.getEndpoint(endpointId);

    const updated = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { events },
    });

    this.invalidateEndpointCache(endpointId);

    return updated.events;
  }

  /**
   * Rotates the webhook signing secret without downtime.
   *
   * Derives a new secret version and stages it as "pending". Until the grace
   * window (WEBHOOK_SECRET_GRACE_SECONDS) elapses, outbound deliveries keep
   * being signed with the established secret — consumers still verifying with
   * the previous value are not cut off. After the window, the pending secret
   * is promoted automatically on the next dispatch (see resolveSigningSecret).
   *
   * The new plaintext secret is returned exactly once.
   */
  async rotateSecret(endpointId: string): Promise<{ secret: string }> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }

    const activeVersion = Math.max(
      endpoint.secretVersion,
      endpoint.pendingSecretVersion ?? 0,
    );
    const newVersion = activeVersion + 1;
    const secret = this.secretService.deriveSecret(endpointId, newVersion);

    await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: {
        pendingSecretVersion: newVersion,
        pendingSecretHash: this.secretService.hashSecret(secret),
        secretGracePeriodEndsAt: new Date(
          Date.now() + this.secretGraceSeconds * 1000,
        ),
      },
    });

    this.invalidateEndpointCache(endpointId);

    this.logger.log(
      `Rotated webhook endpoint ${endpointId} to pending secret v${newVersion} (grace ${this.secretGraceSeconds}s)`,
    );
    this.metrics.incrementCounter('webhooks_secrets_rotated_total', {
      result: 'rotated',
    });

    return { secret }; // Only time the new secret is visible!
  }

  /**
   * Resolves the plaintext signing secret for an outbound delivery.
   *
   * Reads the endpoint fresh from the database (never the cache, so rotation
   * state is always current) and applies the grace-period promotion: once a
   * pending rotation's window has elapsed, the pending version atomically
   * becomes the established signing version. The derived secret is returned
   * to sign the payload; it is never persisted.
   */
  async resolveSigningSecret(endpointId: string): Promise<string> {
    const endpoint = await this.prisma.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });

    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }

    const now = new Date();
    let version = endpoint.secretVersion;

    if (
      endpoint.pendingSecretVersion != null &&
      endpoint.secretGracePeriodEndsAt != null &&
      endpoint.secretGracePeriodEndsAt <= now
    ) {
      // Grace window elapsed — promote the pending secret to active.
      version = endpoint.pendingSecretVersion;
      await this.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: {
          secretVersion: version,
          secretHash:
            endpoint.pendingSecretHash ??
            this.secretService.hashSecret(
              this.secretService.deriveSecret(endpointId, version),
            ),
          pendingSecretVersion: null,
          pendingSecretHash: null,
          secretGracePeriodEndsAt: null,
        },
      });
      this.invalidateEndpointCache(endpointId);
      this.logger.log(
        `Promoted webhook endpoint ${endpointId} to signing secret v${version} after grace period`,
      );
      this.metrics.incrementCounter('webhooks_secrets_promoted_total', {});
    } else if (!endpoint.secretHash) {
      // Lazy backfill for endpoints created before hashed storage existed:
      // derive the secret for the current version and persist its hash.
      const derived = this.secretService.deriveSecret(endpointId, version);
      await this.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { secretHash: this.secretService.hashSecret(derived) },
      });
    }

    return this.secretService.deriveSecret(endpointId, version);
  }

  /**
   * Gets delivery attempts for an endpoint with pagination
   */
  async getDeliveries(
    endpointId: string,
    page: number = 1,
    limit: number = 50,
  ) {
    // Ensure the endpoint exists so callers get a clear 404 instead of an
    // empty list when they pass an unknown/mistyped id.
    await this.getEndpoint(endpointId);

    const skip = (page - 1) * limit;

    const [deliveries, total] = await Promise.all([
      this.prisma.webhookDelivery.findMany({
        where: { endpointId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.webhookDelivery.count({
        where: { endpointId },
      }),
    ]);

    return {
      deliveries,
      page,
      limit,
      total,
    };
  }

  /**
   * Lists dead-lettered deliveries (exhausted all retries) for inspection.
   */
  async getDeadLetters(
    params: { projectId?: string; endpointId?: string; limit?: number } = {},
  ) {
    const { projectId, endpointId, limit = 50 } = params;

    return await this.prisma.webhookDelivery.findMany({
      where: {
        status: DeliveryStatus.FAILED,
        ...(endpointId ? { endpointId } : {}),
        ...(projectId ? { endpoint: { projectId } } : {}),
      },
      include: { endpoint: true },
      orderBy: { lastAttemptAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Requeues a dead-lettered delivery for redelivery by resetting its attempt count.
   * Actual delivery happens on the next dispatcher processing pass.
   */
  async replayDeadLetter(deliveryId: string): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
    });

    if (!delivery) {
      throw new NotFoundException(`Webhook delivery ${deliveryId} not found`);
    }

    if (delivery.status !== DeliveryStatus.FAILED) {
      throw new BadRequestException(
        `Delivery ${deliveryId} is not dead-lettered (status: ${delivery.status})`,
      );
    }

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryStatus.PENDING,
        attempts: 0,
        nextRetryAt: null,
      },
    });

    this.logger.log(`Requeued dead-lettered delivery ${deliveryId}`);
  }

  private invalidateEndpointCache(endpointId: string): void {
    this.cache.delete(`${WEBHOOK_ENDPOINT_CACHE_PREFIX}${endpointId}`);
  }

  /**
   * Maps Prisma endpoint to domain model. Never exposes the signing secret —
   * only its hash and version metadata.
   */
  private mapPrismaEndpointToDomain(prismaEndpoint: any): WebhookEndpoint {
    return {
      id: prismaEndpoint.id,
      projectId: prismaEndpoint.projectId,
      url: prismaEndpoint.url,
      description: prismaEndpoint.description,
      secretHash: prismaEndpoint.secretHash ?? '',
      secretVersion: prismaEndpoint.secretVersion ?? 1,
      pendingSecretVersion: prismaEndpoint.pendingSecretVersion ?? null,
      pendingSecretHash: prismaEndpoint.pendingSecretHash ?? null,
      secretGracePeriodEndsAt: prismaEndpoint.secretGracePeriodEndsAt ?? null,
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
