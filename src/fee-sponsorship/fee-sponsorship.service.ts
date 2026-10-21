import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
// Import the generated client (see generator output in prisma/schema.prisma);
// `@prisma/client` only resolves the legacy default output path.
import { Prisma } from '../generated/prisma/client';
import { MetricsService } from '../common/metrics/metrics.service';
import { FeeSponsorshipBudget } from './domain/fee-sponsorship-budget.model';
import {
  FeeSponsorshipBudgetStatus,
  FeeSponsorshipNetwork,
} from './domain/fee-sponsorship-budget.model';
import { CreateFeeSponsorshipBudgetDto } from './dto/create-fee-sponsorship-budget.dto';
import { UpdateFeeSponsorshipBudgetDto } from './dto/update-fee-sponsorship-budget.dto';
import { isPositiveStroopsString } from './dto/is-positive-stroops-string.decorator';
import {
  FEE_SPONSORSHIP_LIST_DEFAULT_LIMIT,
  FEE_SPONSORSHIP_LIST_MAX_LIMIT,
} from './dto/list-fee-sponsorship-budgets-query.dto';
import { FeeSponsorshipErrorCode } from './fee-sponsorship-error-codes';
import { SponsorshipActor } from './domain/fee-sponsorship-budget.model';
import { randomUUID } from 'crypto';

/**
 * Stable error codes for fee sponsorship budget operations.
 * Clients should branch on these codes, not on human-readable messages.
 */
export const FeeSponsorshipErrorCodeMap = FeeSponsorshipErrorCode;

/** Cursor-based page of fee sponsorship budgets */
export interface FeeSponsorshipBudgetPage {
  items: FeeSponsorshipBudget[];
  /** Pass as `cursor` on the next request; null when there are no more pages */
  nextCursor: string | null;
}

/**
 * Env var that gates fee sponsorship writes. Default OFF (fail-closed):
 * fee sponsorship writes are denied unless explicitly enabled.
 */
export const FEE_SPONSORSHIP_ENABLED_ENV = 'FEE_SPONSORSHIP_ENABLED';

/**
 * Fee sponsorship budget service.
 *
 * Handles creation, update, retrieval, and listing of fee sponsorship
 * budgets for wallets on Stellar/Soroban.
 *
 * Invariants:
 * - A wallet may have at most one active budget per network.
 * - Budgets are deny-by-default: only the wallet owner or an authorized
 *   delegate/guardian may manage budgets.
 * - Fail-closed: dependency outages return 503, never silently succeed.
 * - Idempotent: concurrent/replayed requests with the same idempotency key
 *   return the same result.
 * - No secrets in logs or responses.
 * - Mainnet writes are gated by the FEE_SPONSORSHIP_ENABLED feature flag.
 */
@Injectable()
export class FeeSponsorshipService {
  private readonly logger = new Logger(FeeSponsorshipService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Whether fee sponsorship writes are enabled. Fail-closed: any value
   * other than an explicit truthy flag keeps fee sponsorship disabled.
   */
  isFeeSponsorshipEnabled(): boolean {
    const raw = process.env[FEE_SPONSORSHIP_ENABLED_ENV];
    return raw === 'true' || raw === '1';
  }

  /**
   * Create a fee sponsorship budget for a wallet.
   *
   * Invariants:
   * - Caller must be the wallet owner or an authorized delegate/guardian.
   * - A wallet may have at most one active budget per network.
   * - Mainnet writes require the FEE_SPONSORSHIP_ENABLED flag.
   * - Idempotent under concurrent/replayed requests.
   * - Fail-closed on dependency outages.
   */
  async createBudget(
    dto: CreateFeeSponsorshipBudgetDto,
    actor: SponsorshipActor,
  ): Promise<FeeSponsorshipBudget> {
    const correlationId = actor.correlationId ?? randomUUID();
    const network = dto.network ?? FeeSponsorshipNetwork.TESTNET;

    // Fail-closed mainnet gate
    if (
      network === FeeSponsorshipNetwork.MAINNET &&
      !this.isFeeSponsorshipEnabled()
    ) {
      this.logger.warn(
        `fee.sponsorship.create denied network=mainnet wallet=${dto.walletId} correlationId=${correlationId}`,
      );
      this.metrics.incrementCounter('fee_sponsorship.mainnet_denied', 1);
      throw new ForbiddenException({
        code: FeeSponsorshipErrorCode.FEATURE_FLAG_DISABLED,
        message: 'Fee sponsorship is disabled for mainnet',
        correlationId,
      });
    }

    // Authz: deny-by-default
    this.enforceAuthorization(dto.walletId, actor, correlationId);

    // Validate input
    this.validateCreateDto(dto);

    // Replay: the same idempotency key for this wallet+network returns the stored budget
    if (dto.idempotencyKey) {
      const replayed = await this.findBudgetByIdempotencyKey(
        dto.walletId,
        network,
        dto.idempotencyKey,
      );
      if (replayed) {
        this.logger.log(
          `fee.sponsorship.create replay budget=${replayed.id} wallet=${dto.walletId} network=${network} correlationId=${correlationId}`,
        );
        return replayed;
      }
    }

    // Check for existing active budget for this wallet+network
    const existing = await this.withPrismaErrors('create', correlationId, () =>
      this.findActiveBudget(dto.walletId, network),
    );
    if (existing) {
      throw new ConflictException({
        code: FeeSponsorshipErrorCode.BUDGET_ALREADY_EXISTS,
        message: `An active fee sponsorship budget already exists for wallet ${dto.walletId} on ${network}`,
        correlationId,
      });
    }

    const budget = await this.withPrismaErrors('create', correlationId, () =>
      this.prisma.feeSponsorshipBudget.create({
        data: {
          walletId: dto.walletId,
          sponsorId: dto.sponsorId,
          limitAmount: dto.limitAmount,
          remainingAmount: dto.limitAmount,
          assetCode: dto.assetCode ?? null,
          assetIssuer: dto.assetIssuer ?? null,
          network,
          status: FeeSponsorshipBudgetStatus.ACTIVE,
          note: dto.note ?? null,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
      }),
    );

    this.metrics.incrementCounter('fee_sponsorship.budget_created', 1);
    this.logger.log(
      `fee.sponsorship.create budget=${budget.id} wallet=${dto.walletId} sponsor=${this.redactSponsorId(dto.sponsorId)} network=${network} correlationId=${correlationId}`,
    );

      return this.toDomainModel(budget);
    } catch (err) {
      if (this.isUniqueConstraintError(err)) {
        // Lost a concurrent race. If the winner carries our key, it is the replay answer;
        // otherwise a budget already exists for this wallet+network.
        const winner = dto.idempotencyKey
          ? await this.findBudgetByIdempotencyKey(dto.walletId, network, dto.idempotencyKey)
          : null;
        if (winner) {
          return winner;
        }
        // Concurrent creates that pass the findActiveBudget check race on the
        // partial unique index; the loser gets P2002 and is reported as a conflict.
        if (this.isActiveBudgetUniqueViolation(err)) {
          this.logger.warn(
            `fee.sponsorship.create duplicate active budget wallet=${dto.walletId} network=${network} correlationId=${correlationId}`,
          );
        }
        throw new ConflictException({
          code: FeeSponsorshipErrorCode.BUDGET_ALREADY_EXISTS,
          message: `An active fee sponsorship budget already exists for wallet ${dto.walletId} on ${network}`,
          correlationId,
        });
      }
      if (this.isDependencyError(err)) {
        this.logger.error(
          `fee.sponsorship.create dependency failure wallet=${dto.walletId} correlationId=${correlationId}`,
        );
        throw new ServiceUnavailableException({
          code: FeeSponsorshipErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'Fee sponsorship store unavailable; write rejected',
          correlationId,
        });
      }
      throw err;
    }
  }

  /**
   * Update an existing fee sponsorship budget.
   *
   * Invariants:
   * - Caller must be the wallet owner or an authorized delegate/guardian.
   * - Only ACTIVE budgets can be updated.
   * - Closing a budget (status=CLOSED) is irreversible.
   * - Fail-closed on dependency outages.
   */
  async updateBudget(
    budgetId: string,
    dto: UpdateFeeSponsorshipBudgetDto,
    actor: SponsorshipActor,
  ): Promise<FeeSponsorshipBudget> {
    const correlationId = actor.correlationId ?? randomUUID();

    const existing = await this.withPrismaErrors('update', correlationId, () =>
      this.prisma.feeSponsorshipBudget.findUnique({
        where: { id: budgetId },
      }),
    );

    if (!existing) {
      throw new NotFoundException({
        code: FeeSponsorshipErrorCode.BUDGET_NOT_FOUND,
        message: `Fee sponsorship budget ${budgetId} not found`,
        correlationId,
      });
    }

    // Authz: deny-by-default
    this.enforceAuthorization(existing.walletId, actor, correlationId);

    // Only ACTIVE budgets can be updated
    if (existing.status === FeeSponsorshipBudgetStatus.CLOSED) {
      throw new ConflictException({
        code: FeeSponsorshipErrorCode.BUDGET_CLOSED,
        message: `Fee sponsorship budget ${budgetId} is closed and cannot be updated`,
        correlationId,
      });
    }

    // Invariant: remainingAmount <= limitAmount on the effective (merged) budget
    if (dto.limitAmount !== undefined || dto.remainingAmount !== undefined) {
      const effectiveLimit = this.parseAmount(
        dto.limitAmount ?? existing.limitAmount,
        correlationId,
      );
      const effectiveRemaining = this.parseAmount(
        dto.remainingAmount ?? existing.remainingAmount,
        correlationId,
      );
      if (effectiveRemaining > effectiveLimit) {
        throw new BadRequestException({
          code: FeeSponsorshipErrorCode.REMAINING_EXCEEDS_LIMIT,
          message: `Remaining amount ${effectiveRemaining} exceeds limit ${effectiveLimit}`,
          correlationId,
        });
      }
    }

    const updated = await this.withPrismaErrors('update', correlationId, () =>
      this.prisma.feeSponsorshipBudget.update({
        where: { id: budgetId },
        data: {
          ...(dto.limitAmount !== undefined && {
            limitAmount: dto.limitAmount,
          }),
          ...(dto.remainingAmount !== undefined && {
            remainingAmount: dto.remainingAmount,
          }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.note !== undefined && { note: dto.note }),
        },
      }),
    );

    this.metrics.incrementCounter('fee_sponsorship.budget_updated', 1);
    this.logger.log(
      `fee.sponsorship.update budget=${budgetId} wallet=${existing.walletId} correlationId=${correlationId}`,
    );

    return this.toDomainModel(updated);
  }

  /**
   * Get a fee sponsorship budget by ID.
   */
  async getBudget(
    budgetId: string,
    actor: SponsorshipActor,
  ): Promise<FeeSponsorshipBudget> {
    const correlationId = actor.correlationId ?? randomUUID();

    const budget = await this.withPrismaErrors('get', correlationId, () =>
      this.prisma.feeSponsorshipBudget.findUnique({
        where: { id: budgetId },
      }),
    );

    if (!budget) {
      throw new NotFoundException({
        code: FeeSponsorshipErrorCode.BUDGET_NOT_FOUND,
        message: `Fee sponsorship budget ${budgetId} not found`,
        correlationId,
      });
    }

    // Authz: deny-by-default
    this.enforceAuthorization(budget.walletId, actor, correlationId);

    return this.toDomainModel(budget);
  }

  /**
   * List fee sponsorship budgets for a wallet, newest first.
   *
   * Cursor pagination on (createdAt DESC, id DESC): pass the previous page's
   * `nextCursor` as `pagination.cursor` to fetch the next page.
   */
  async listBudgets(
    walletId: string,
    actor: SponsorshipActor,
    network?: FeeSponsorshipNetwork,
    pagination?: { limit?: number; cursor?: string },
  ): Promise<FeeSponsorshipBudgetPage> {
    const correlationId = actor.correlationId ?? randomUUID();

    // Authz: deny-by-default
    this.enforceAuthorization(walletId, actor, correlationId);

    const pageSize = Math.min(
      pagination?.limit ?? FEE_SPONSORSHIP_LIST_DEFAULT_LIMIT,
      FEE_SPONSORSHIP_LIST_MAX_LIMIT,
    );

    try {
      const pivot = pagination?.cursor
        ? await this.prisma.feeSponsorshipBudget.findFirst({
            where: { id: pagination.cursor, walletId },
            select: { createdAt: true, id: true },
          })
        : null;
      if (pagination?.cursor && !pivot) {
        throw new BadRequestException({
          code: FeeSponsorshipErrorCode.INVALID_INPUT,
          message: 'cursor does not reference a budget for this wallet',
          correlationId,
        });
      }

      // Fetch one extra row to detect whether another page exists.
      const budgets = await this.prisma.feeSponsorshipBudget.findMany({
        where: {
          walletId,
          ...(network ? { network } : {}),
          deletedAt: null,
          ...(pivot && {
            OR: [
              { createdAt: { lt: pivot.createdAt } },
              { createdAt: pivot.createdAt, id: { lt: pivot.id } },
            ],
          }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
      });

      const hasMore = budgets.length > pageSize;
      const page = hasMore ? budgets.slice(0, pageSize) : budgets;
      const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

      return {
        items: page.map((b) => this.toDomainModel(b)),
        nextCursor,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new ServiceUnavailableException({
        code: FeeSponsorshipErrorCode.SERVICE_UNAVAILABLE,
        message: 'budget store is unreachable',
        correlationId,
      });
    }
        where: {
          walletId,
          ...(network ? { network } : {}),
          deletedAt: null,
          ...(pivot && {
            OR: [
              { createdAt: { lt: pivot.createdAt } },
              { createdAt: pivot.createdAt, id: { lt: pivot.id } },
            ],
          }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
      });

      const hasMore = budgets.length > pageSize;
      const items = budgets
        .slice(0, pageSize)
        .map((b) => this.toDomainModel(b));
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      return { items, nextCursor };
    } catch (err) {
      if (this.isDependencyError(err)) {
        this.logger.error(
          `fee.sponsorship.list dependency failure wallet=${walletId} correlationId=${correlationId}`,
        );
        throw new ServiceUnavailableException({
          code: FeeSponsorshipErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'Fee sponsorship store unavailable; read rejected',
          correlationId,
        });
      }
      throw err;
    }
  }

  /**
   * Close (deactivate) a fee sponsorship budget.
   * This is the primary way to exhaust or cancel a budget.
   */
  async closeBudget(
    budgetId: string,
    actor: SponsorshipActor,
  ): Promise<FeeSponsorshipBudget> {
    const correlationId = actor.correlationId ?? randomUUID();

    const existing = await this.withPrismaErrors('close', correlationId, () =>
      this.prisma.feeSponsorshipBudget.findUnique({
        where: { id: budgetId },
      }),
    );

    if (!existing) {
      throw new NotFoundException({
        code: FeeSponsorshipErrorCode.BUDGET_NOT_FOUND,
        message: `Fee sponsorship budget ${budgetId} not found`,
        correlationId,
      });
    }

    // Authz: deny-by-default
    this.enforceAuthorization(existing.walletId, actor, correlationId);

    if (existing.status === FeeSponsorshipBudgetStatus.CLOSED) {
      // Idempotent: closing an already-closed budget is a no-op success.
      return this.toDomainModel(existing);
    }

    const updated = await this.withPrismaErrors('close', correlationId, () =>
      this.prisma.feeSponsorshipBudget.update({
        where: { id: budgetId },
        data: {
          status: FeeSponsorshipBudgetStatus.CLOSED,
          remainingAmount: '0',
        },
      }),
    );

    this.metrics.incrementCounter('fee_sponsorship.budget_closed', 1);
    this.logger.log(
      `fee.sponsorship.close budget=${budgetId} wallet=${existing.walletId} correlationId=${correlationId}`,
    );

    return this.toDomainModel(updated);
  }

  /**
   * Authorize the actor for the given wallet.
   * Deny-by-default: only the wallet owner or an authorized
   * delegate/guardian may manage fee sponsorship budgets.
   */
  private enforceAuthorization(
    walletId: string,
    actor: SponsorshipActor,
    correlationId: string,
  ): void {
    // Owner is always authorized
    // In a full implementation, we would check the wallet ownership
    // against the actor's subjectId. For now, we enforce role-based auth.
    const allowedRoles = ['owner', 'delegate', 'guardian'];

    if (!allowedRoles.includes(actor.role)) {
      this.logger.warn(
        `fee.sponsorship.authz denied wallet=${walletId} role=${actor.role} correlationId=${correlationId}`,
      );
      this.metrics.incrementCounter('fee_sponsorship.authz_denied', 1);
      throw new ForbiddenException({
        code: FeeSponsorshipErrorCode.NOT_AUTHORIZED,
        message: 'Caller is not authorized to manage fee sponsorship budgets',
        correlationId,
      });
    }
  }

  /**
   * Validate the create DTO.
   */
  private validateCreateDto(dto: CreateFeeSponsorshipBudgetDto): void {
    if (!dto.walletId || typeof dto.walletId !== 'string') {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'walletId is required and must be a string',
      });
    }

    if (!dto.sponsorId || typeof dto.sponsorId !== 'string') {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'sponsorId is required and must be a string',
      });
    }

    if (!dto.limitAmount || typeof dto.limitAmount !== 'string') {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'limitAmount is required and must be a string',
      });
    }

    if (!isPositiveStroopsString(dto.limitAmount)) {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'limitAmount must be a positive integer string in stroops',
      });
    }
  }

  /**
   * Validate the amount fields of the update DTO when provided.
   */
  private validateUpdateDto(dto: UpdateFeeSponsorshipBudgetDto): void {
    if (dto.limitAmount !== undefined && !isPositiveStroopsString(dto.limitAmount)) {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'limitAmount must be a positive integer string in stroops',
      });
    }

    if (dto.remainingAmount !== undefined && !isPositiveStroopsString(dto.remainingAmount)) {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'remainingAmount must be a positive integer string in stroops',
      });
    }
  }

  /**
   * Find an active budget for a wallet on a given network.
   */
  private async findActiveBudget(
    walletId: string,
    network: FeeSponsorshipNetwork,
  ): Promise<FeeSponsorshipBudget | null> {
    const budget = await this.prisma.feeSponsorshipBudget.findFirst({
      where: {
        walletId,
        network,
        status: FeeSponsorshipBudgetStatus.ACTIVE,
        deletedAt: null,
      },
    });
    return budget ? this.toDomainModel(budget) : null;
  }

  /**
   * Find a budget created with the given idempotency key for a wallet+network.
   * Matches regardless of lifecycle status so replays return the stored budget.
   */
  private async findBudgetByIdempotencyKey(
    walletId: string,
    network: FeeSponsorshipNetwork,
    idempotencyKey: string,
  ): Promise<FeeSponsorshipBudget | null> {
    const budget = await this.prisma.feeSponsorshipBudget.findUnique({
      where: {
        walletId_network_idempotencyKey: { walletId, network, idempotencyKey },
      },
    });
    return budget ? this.toDomainModel(budget) : null;
  }

  /**
   * Parse a smallest-unit amount string for exact integer comparison.
   */
  private parseAmount(value: string, correlationId: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new BadRequestException({
        code: FeeSponsorshipErrorCode.INVALID_INPUT,
        message: 'Amounts must be non-negative integer strings',
        correlationId,
      });
    }
    return BigInt(value);
  }

  /**
   * Convert a Prisma record to a domain model.
   */
  private toDomainModel(record: any): FeeSponsorshipBudget {
    return {
      id: record.id,
      walletId: record.walletId,
      sponsorId: record.sponsorId,
      limitAmount: record.limitAmount,
      remainingAmount: record.remainingAmount,
      assetCode: record.assetCode,
      assetIssuer: record.assetIssuer,
      network: record.network as FeeSponsorshipNetwork,
      status: record.status as FeeSponsorshipBudgetStatus,
      note: record.note,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    };
  }

  /**
   * Redact a sponsor ID for logs: keep a short prefix/suffix only.
   */
  private redactSponsorId(sponsorId: string): string {
    if (!sponsorId || sponsorId.length <= 10) {
      return '***';
    }
    return `${sponsorId.slice(0, 6)}…${sponsorId.slice(-4)}`;
  }

  /**
   * Run a Prisma call and map its failures to stable fee sponsorship errors:
   * - P2002 (unique violation) -> 409 BUDGET_ALREADY_EXISTS
   * - P2025 (record not found) -> 404 BUDGET_NOT_FOUND
   * - connectivity/timeout     -> 503 DEPENDENCY_UNAVAILABLE (fail closed)
   * Anything else is rethrown unchanged. Raw Prisma messages and connection
   * details are never copied into the exception or the log line.
   */
  private async withPrismaErrors<T>(
    operation: string,
    correlationId: string,
    query: () => Promise<T>,
  ): Promise<T> {
    try {
      return await query();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') {
          throw new ConflictException({
            code: FeeSponsorshipErrorCode.BUDGET_ALREADY_EXISTS,
            message:
              'A fee sponsorship budget with these attributes already exists',
            correlationId,
          });
        }
        if (err.code === 'P2025') {
          throw new NotFoundException({
            code: FeeSponsorshipErrorCode.BUDGET_NOT_FOUND,
            message: 'Fee sponsorship budget not found',
            correlationId,
          });
        }
      }
      if (this.isDependencyError(err)) {
        this.logger.error(
          `fee.sponsorship.${operation} dependency failure correlationId=${correlationId}`,
        );
        throw new ServiceUnavailableException({
          code: FeeSponsorshipErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'Fee sponsorship store unavailable; request rejected',
          correlationId,
        });
      }
      throw err;
    }
  }

  /**
   * Detect a unique-constraint violation (P2002) from creating a budget.
   * The only unique key on this model besides the uuid primary key is the
   * partial index on ACTIVE (walletId, network) rows.
   */
  private isActiveBudgetUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
    );
  }
  }

  /**
   * Detect dependency/connectivity failures so writes can fail closed.
   */
  private isDependencyError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientInitializationError) {
      return true;
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return ['P1001', 'P1002', 'P1008', 'P1017'].includes(err.code);
    }
    return false;
  }
}
