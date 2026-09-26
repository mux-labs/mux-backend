import {
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  ApiKey,
  ApiKeyContext,
  ApiKeyErrorCode,
  ApiKeyInfo,
  ApiKeyStatus,
} from './domain/api-key.model';
import { assertNetworkMatch } from '../common/network/network-mismatch';

export type { ApiKeyInfo, ApiKeyContext };

export interface CreateApiKeyRequest {
  name: string;
  projectId: string;
  /** Explicit expiry; wins over the configured default. */
  expiresAt?: Date | string;
  /**
   * Network scope. `undefined`/`null` = all networks. A scoped key is refused
   * on any other network with `NETWORK_MISMATCH` (#943).
   */
  network?: 'MAINNET' | 'TESTNET' | null;
}

export interface CreateApiKeyResult {
  apiKey: ApiKey;
  /** Only ever returned once, at creation time. Never persisted in plaintext. */
  plainTextKey: string;
}

/**
 * Minimal structural view of the Prisma models this service needs.
 *
 * Declared structurally (rather than importing the generated Prisma types) so
 * the service can be unit-tested with an in-memory stub and so the api-keys
 * domain does not couple to a database build.
 */
interface ApiKeyStore {
  project: {
    findUnique(args: { where: { id: string } }): Promise<any>;
  };
  apiKey: {
    create(args: { data: Record<string, unknown> }): Promise<any>;
    findUnique(args: {
      where: Record<string, unknown>;
      include?: unknown;
    }): Promise<any>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<any>;
  };
  apiKeyUsage?: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

const KEY_PREFIX_PATTERN = /^mux_(test|live)_/;
const DEFAULT_GRACE_PERIOD_SECONDS = 3600;

/**
 * Service for creating, validating and revoking API keys (#942).
 *
 * Invariants:
 *
 * 1. **Revocation is immediate and uncached.** Every `validateApiKey` call
 *    reads the authoritative row and checks `REVOKED` *before* any other
 *    condition. There is no in-process positive cache in front of that read, so
 *    a key revoked between two requests fails on the very next request.
 *    `REVOKED` is a terminal state — a revoked key can never be reactivated,
 *    only replaced.
 * 2. **Only the hash is stored.** The plaintext key is returned exactly once
 *    from `createApiKey` and compared with `crypto.timingSafeEqual` on
 *    validation. Neither the plaintext nor its hash is ever logged.
 * 3. **Fail-closed on expiry.** An expired key is marked `EXPIRED` in the store
 *    on first rejection and refused from then on.
 * 4. **Network-scoped.** A key scoped to TESTNET/MAINNET is refused on any
 *    other network with the stable `NETWORK_MISMATCH` code (#943). A `null`
 *    scope means all networks.
 * 5. **Fail-closed on store outage.** If the key store cannot be reached the
 *    request is refused with 503 rather than falling through to a guess.
 */
@Injectable()
export class ApiKeyService implements OnModuleDestroy {
  private readonly logger = new Logger(ApiKeyService.name);

  /**
   * The key store. Assigned by the constructor when the generated Prisma
   * client is available; tests may replace it directly with a stub.
   */
  private prisma: ApiKeyStore | null = null;

  private readonly gracePeriodSeconds: number;

  /** Default lifetime (days) for new keys; 0 means non-expiring. */
  private readonly defaultExpiryDays: number;

  /**
   * Whether the documented offline verifier may be consulted.
   *
   * The platform's e2e suites intentionally run without seeded API-key rows.
   * To keep them runnable the historic prefix-based verifier is retained — but
   * **only** for the explicit `test`/`development` environments. Any other
   * value (notably `production` and `staging`) is fail-closed: an unknown key
   * is refused.
   */
  private readonly offlineVerifierEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.gracePeriodSeconds =
      this.configService.get<number>('API_KEY_ROTATION_GRACE_SECONDS') ??
      DEFAULT_GRACE_PERIOD_SECONDS;
    this.defaultExpiryDays =
      this.configService.get<number>('API_KEY_DEFAULT_EXPIRY_DAYS') ?? 0;

    const nodeEnv = (
      this.configService.get<string>('NODE_ENV') ??
      process.env.NODE_ENV ??
      ''
    )
      .trim()
      .toLowerCase();
    // Production is never allowed to enable the offline verifier, regardless
    // of any other setting.
    this.offlineVerifierEnabled =
      nodeEnv !== 'production' &&
      (nodeEnv === 'test' || nodeEnv === 'development');

    this.prisma = this.createStore();
  }

  async onModuleDestroy(): Promise<void> {
    const store = this.prisma as { $disconnect?: () => Promise<void> } | null;
    if (typeof store?.$disconnect === 'function') {
      await store.$disconnect();
    }
  }

  // ── create ────────────────────────────────────────────────────────────────

  /**
   * Mints a new API key for a project.
   *
   * Format: `mux_{test|live}_{random32chars}`. `live` is only used for
   * production projects; every other environment mints a `test` key.
   */
  async createApiKey(
    request: CreateApiKeyRequest,
  ): Promise<CreateApiKeyResult> {
    const store = this.requireStore();

    const project = await store.project.findUnique({
      where: { id: request.projectId },
    });

    if (!project) {
      throw new NotFoundException({
        code: ApiKeyErrorCode.NOT_FOUND,
        message: `Project ${request.projectId} not found`,
      });
    }

    const environment = project.environment === 'production' ? 'live' : 'test';
    const randomPart = crypto.randomBytes(24).toString('base64url');
    const plainTextKey = `mux_${environment}_${randomPart}`;
    const keyHash = this.hashApiKey(plainTextKey);

    const expiresAt = request.expiresAt
      ? new Date(request.expiresAt)
      : this.defaultExpiryDays > 0
        ? new Date(Date.now() + this.defaultExpiryDays * 24 * 60 * 60 * 1000)
        : undefined;

    const record = await store.apiKey.create({
      data: {
        name: request.name,
        keyHash,
        keyPrefix: `mux_${environment}_`,
        lastFour: randomPart.slice(-4),
        projectId: request.projectId,
        network: request.network ?? null,
        status: ApiKeyStatus.ACTIVE,
        expiresAt,
      },
    });

    // Ops-safe: ids and status only — never the key, its hash, or the pepper.
    this.logger.log(
      `api-key created id=${record.id} projectId=${request.projectId} ` +
        `network=${request.network ?? 'ALL'}`,
    );

    return {
      apiKey: this.mapPrismaApiKeyToDomain(record),
      plainTextKey,
    };
  }

  // ── validate ──────────────────────────────────────────────────────────────

  /**
   * Validates a plaintext API key and returns its context.
   *
   * @throws UnauthorizedException with a stable `ApiKeyErrorCode` when the key
   *   is malformed, unknown, revoked, suspended, expired, or past its rotation
   *   grace period.
   * @throws ServiceUnavailableException when the store is unreachable and the
   *   offline verifier is not permitted (any non-test/development environment).
   */
  async validateApiKey(plainTextKey: string): Promise<ApiKeyInfo> {
    if (!plainTextKey || !plainTextKey.startsWith('mux_')) {
      throw this.unauthorized(
        ApiKeyErrorCode.INVALID_FORMAT,
        'Invalid API key format',
      );
    }

    const store = this.prisma;

    if (store) {
      try {
        const fromStore = await this.validateFromStore(plainTextKey, store);
        if (fromStore) {
          return fromStore;
        }
      } catch (error) {
        // An HttpException is an authoritative denial from the store (revoked,
        // expired, suspended, ...). Never mask it with the offline verifier.
        if (error instanceof HttpException) {
          throw error;
        }
        if (!this.offlineVerifierEnabled) {
          this.logger.error(
            `api-key store unavailable during validation: ${(error as Error)?.message}`,
          );
          throw new ServiceUnavailableException({
            code: ApiKeyErrorCode.STORE_UNAVAILABLE,
            message: 'API key validation is temporarily unavailable',
          });
        }
        this.logger.warn(
          'api-key store unavailable; falling back to the offline verifier ' +
            '(test/development only)',
        );
      }
    }

    return this.validateOffline(plainTextKey);
  }

  /**
   * Store-backed validation. Returns `null` when no row matches the hash so the
   * caller can decide whether the offline verifier may be consulted.
   */
  private async validateFromStore(
    plainTextKey: string,
    store: ApiKeyStore,
  ): Promise<ApiKeyInfo | null> {
    const keyHash = this.hashApiKey(plainTextKey);

    const record = await store.apiKey.findUnique({
      where: { keyHash },
      include: { project: { include: { developer: true } } },
    });

    if (!record) {
      return null;
    }

    // Defence-in-depth: the lookup is indexed on keyHash, but compare the
    // hashes in constant time so a mismatched record can never be accepted.
    const provided = Buffer.from(keyHash);
    const stored = Buffer.from(String(record.keyHash ?? ''));
    if (
      provided.length !== stored.length ||
      !crypto.timingSafeEqual(provided, stored)
    ) {
      throw this.unauthorized(ApiKeyErrorCode.INVALID, 'Invalid API key');
    }

    // Revocation is checked FIRST and is terminal: a revoked key never becomes
    // usable again, and this read is uncached, so revocation is immediate.
    if (record.status === ApiKeyStatus.REVOKED) {
      throw this.unauthorized(
        ApiKeyErrorCode.REVOKED,
        'API key has been revoked',
      );
    }

    if (record.status === ApiKeyStatus.SUSPENDED) {
      throw this.unauthorized(
        ApiKeyErrorCode.SUSPENDED,
        'API key is suspended',
      );
    }

    if (record.status === ApiKeyStatus.EXPIRED) {
      throw this.unauthorized(ApiKeyErrorCode.EXPIRED, 'API key has expired');
    }

    if (record.gracePeriodEndsAt && record.gracePeriodEndsAt < new Date()) {
      throw this.unauthorized(
        ApiKeyErrorCode.GRACE_PERIOD_EXPIRED,
        'API key rotation grace period expired',
      );
    }

    if (record.expiresAt && record.expiresAt < new Date()) {
      // Mark it expired so subsequent requests are refused at the status check
      // and so operators can see *why* the key stopped working.
      await store.apiKey.update({
        where: { id: record.id },
        data: { status: ApiKeyStatus.EXPIRED },
      });
      throw this.unauthorized(ApiKeyErrorCode.EXPIRED, 'API key has expired');
    }

    // Fire-and-forget: failing to record usage must never fail the request.
    void this.recordUsage(record.id);

    return {
      apiKey: this.mapPrismaApiKeyToDomain(record),
      project: record.project,
      developer: record.project?.developer,
    };
  }

  /**
   * Offline verifier for the test/development e2e suites.
   *
   * Only consulted when {@link offlineVerifierEnabled} is true, which the
   * constructor refuses to allow outside `test`/`development`.
   */
  private validateOffline(plainTextKey: string): ApiKeyInfo {
    if (
      !this.offlineVerifierEnabled ||
      !KEY_PREFIX_PATTERN.test(plainTextKey)
    ) {
      throw this.unauthorized(ApiKeyErrorCode.INVALID, 'Invalid API key');
    }

    const now = new Date();
    return {
      apiKey: {
        id: 'api-key-offline',
        name: 'offline-verifier',
        keyHash: this.hashApiKey(plainTextKey),
        keyPrefix: 'mux_offline_',
        lastFour: plainTextKey.slice(-4),
        projectId: 'proj-offline',
        // Unscoped: the offline verifier can never widen a network restriction.
        network: null,
        status: ApiKeyStatus.ACTIVE,
        createdAt: now,
        updatedAt: now,
      },
      project: {
        id: 'proj-offline',
        name: 'offline',
        environment: 'development',
        developerId: 'dev-offline',
        rateLimitRpm: 0,
        roles: [],
      },
      developer: {
        id: 'dev-offline',
        email: 'offline@example.com',
      },
    };
  }

  // ── revoke ────────────────────────────────────────────────────────────────

  /**
   * Revokes an API key.
   *
   * Immediate: the very next `validateApiKey` sees `REVOKED` and refuses the
   * key. Idempotent: revoking an already-revoked key succeeds and returns the
   * existing record, so a retried revocation is not an error.
   *
   * @param developerId When supplied, the key must belong to this developer.
   */
  async revokeApiKey(
    apiKeyId: string,
    reason?: string,
    developerId?: string,
  ): Promise<ApiKey> {
    const store = this.requireStore();

    const existing = await store.apiKey.findUnique({
      where: { id: apiKeyId },
      include: { project: true },
    });

    if (!existing) {
      throw new NotFoundException({
        code: ApiKeyErrorCode.NOT_FOUND,
        message: `API key ${apiKeyId} not found`,
      });
    }

    if (developerId && existing.project?.developerId !== developerId) {
      this.logger.warn(
        `api-key revoke denied id=${apiKeyId}: caller does not own the key`,
      );
      throw new ForbiddenException({
        code: ApiKeyErrorCode.FORBIDDEN,
        message: 'You do not have access to this API key',
      });
    }

    // Already revoked: return the record unchanged (idempotent).
    if (existing.status === ApiKeyStatus.REVOKED) {
      return this.mapPrismaApiKeyToDomain(existing);
    }

    const updated = await store.apiKey.update({
      where: { id: apiKeyId },
      data: {
        status: ApiKeyStatus.REVOKED,
        revokedAt: new Date(),
        revokedReason: reason ?? null,
      },
    });

    // Ops-safe: id and outcome only. The caller-supplied reason is persisted,
    // not logged, so a secret pasted into it cannot leak into the log stream.
    this.logger.log(`api-key revoked id=${apiKeyId}`);

    return this.mapPrismaApiKeyToDomain(updated);
  }

  // ── network scope (#943) ──────────────────────────────────────────────────

  /**
   * Refuses a request whose target network is outside the key's scope.
   *
   * Unscoped keys (`network === null`) allow every network; a scoped key is
   * refused on any other network with the stable `NETWORK_MISMATCH` code.
   */
  assertNetworkAllowed(
    context: Pick<ApiKeyInfo, 'apiKey'>,
    requestedNetwork: string | null | undefined,
    correlationId?: string,
  ): void {
    assertNetworkMatch({
      scope: context.apiKey?.network ?? null,
      requested: requestedNetwork,
      correlationId,
      subject: 'api-key',
    });
  }

  // ── usage ─────────────────────────────────────────────────────────────────

  /**
   * Records a single successful use. Best-effort: never throws.
   *
   * The guard supplies the full request context; the extra parameters are all
   * optional so callers that only know the key id can still record a use.
   */
  async recordUsage(
    apiKeyId: string,
    projectId?: string,
    endpoint?: string,
    method?: string,
    statusCode?: number,
    ipAddress?: string,
    userAgent?: string,
    durationMs?: number,
  ): Promise<void> {
    const store = this.prisma;
    if (!store?.apiKeyUsage) {
      return;
    }
    try {
      await store.apiKeyUsage.create({
        data: {
          apiKeyId,
          projectId,
          endpoint,
          method,
          statusCode,
          ipAddress,
          userAgent,
          durationMs,
        },
      });
    } catch (error) {
      this.logger.warn(
        `api-key usage could not be recorded (id=${apiKeyId}): ${(error as Error)?.message}`,
      );
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * SHA-256 of the plaintext key, optionally peppered with `API_KEY_PEPPER`.
   * The pepper is read per call so rotating it is a config change, not a code
   * change.
   */
  private hashApiKey(plainTextKey: string): string {
    const pepper = this.configService.get<string>('API_KEY_PEPPER') ?? '';
    return crypto
      .createHash('sha256')
      .update(`${pepper}${plainTextKey}`)
      .digest('hex');
  }

  private requireStore(): ApiKeyStore {
    if (!this.prisma) {
      throw new ServiceUnavailableException({
        code: ApiKeyErrorCode.STORE_UNAVAILABLE,
        message: 'API key store is unavailable',
      });
    }
    return this.prisma;
  }

  /**
   * Instantiates the Prisma-backed store.
   *
   * Never connects here — Prisma opens connections lazily on first query — and
   * returns `null` when the generated client cannot be constructed (e.g. a
   * unit test without `prisma generate`). The service treats `null` as a store
   * outage, so this can never degrade into an unchecked write.
   */
  private createStore(): ApiKeyStore | null {
    try {
      // Required lazily so importing this module never hard-fails in an
      // environment where the Prisma client has not been generated.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PrismaClient } = require('../generated/prisma/client') as {
        PrismaClient: new (options: Record<string, unknown>) => ApiKeyStore;
      };
      return new PrismaClient({});
    } catch {
      return null;
    }
  }

  private mapPrismaApiKeyToDomain(record: any): ApiKey {
    return {
      id: record.id,
      name: record.name,
      keyHash: record.keyHash,
      keyPrefix: record.keyPrefix,
      lastFour: record.lastFour,
      projectId: record.projectId,
      // `null` in the database means "all networks".
      network: record.network ?? undefined,
      status: record.status,
      // `undefined` (not `null`) when there is no expiry, so callers can rely
      // on `expiresAt === undefined` for a non-expiring key.
      expiresAt: record.expiresAt ?? undefined,
      lastUsedAt: record.lastUsedAt ?? null,
      revokedAt: record.revokedAt ?? null,
      revokedReason: record.revokedReason ?? null,
      gracePeriodEndsAt: record.gracePeriodEndsAt ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private unauthorized(code: ApiKeyErrorCode, message: string) {
    return new UnauthorizedException({ code, message });
  }
}
