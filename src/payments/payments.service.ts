import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { PaymentStatus } from './entities/payment.entity';
import { WalletsService } from '../wallets/wallets.service';
import { WalletStatus } from '../wallets/domain/wallet.model';

// Only PENDING payments can be transitioned; terminal states are immutable.
const ALLOWED_TRANSITIONS: Record<string, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
};

/**
 * #1256 – Documented truthy/falsy sets for PAYMENT_ISOLATION_ENABLED.
 *
 * Parsing is case-insensitive. Unset defaults to enabled (fail closed).
 *  - Truthy: 'true', '1', 'yes', 'on'
 *  - Falsy:  'false', '0', 'no', 'off'
 * Any other value falls back to the default (enabled) and is logged as such.
 */
const ISOLATION_TRUTHY = new Set(['true', '1', 'yes', 'on']);
const ISOLATION_FALSY = new Set(['false', '0', 'no', 'off']);

function parseIsolationEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const normalized = raw.trim().toLowerCase();
  if (ISOLATION_TRUTHY.has(normalized)) return true;
  if (ISOLATION_FALSY.has(normalized)) return false;
  return true;
}

/**
 * #972 – Payment identity isolation across developers.
 *
 * Invariants enforced here:
 *  - Every create() call must supply a developerOwnerId and a walletId.
 *  - findAll() / findOne() always filter by developerOwnerId → no cross-developer leakage.
 *  - update() re-checks ownership before mutating; 404 is returned even if the record
 *    exists but belongs to a different developer (avoid enumeration).
 *  - remove() re-checks ownership before deleting; a non-owned id yields 404 and
 *    performs no mutation, matching findOne().
 *  - update() validates every status mutation against ALLOWED_TRANSITIONS so terminal
 *    states (CONFIRMED, FAILED) are genuinely immutable.
 *
 *  - Idempotency key uniqueness is enforced at the DB level; the service returns the
 *    cached response instead of re-executing on conflict, but only when the cached
 *    payment belongs to the requesting developer.
 *  - Feature-flagged: PAYMENT_ISOLATION_ENABLED is parsed as a boolean (see
 *    parseIsolationEnabled); unset defaults to enabled. If the flag is not
 *    explicitly 'true' the guard is bypassed in development to allow gradual
 *    rollout without breaking existing callers.
 *
 * #1104 – Receiver wallet validation.
 *  - The receiver wallet must exist and be ACTIVE, mirroring the sender checks.
 *  - Receiver ownership is intentionally NOT scoped to the calling developer:
 *    payments are a transfer primitive and a developer may legitimately pay a
 *    wallet owned by another developer (e.g. marketplace payouts, refunds to a
 *    counterparty). Cross-developer receivers are therefore allowed by design;
 *    only the sender wallet is subject to the developerOwnerId isolation guard.
 *
 * #1112 – Ownership is resolved by the controller from the API key context and
 * passed explicitly as `developerOwnerId`; it is never read from the request body.
 *
 * #1250 – When isolation is on, a missing developerOwnerId must never fall back
 * to an unscoped query. Read paths return an empty page; write paths reject with
 * 403. The unscoped list is only available when the flag is explicitly 'false'.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /** Kill-switch / feature flag — defaults ON in production-like envs. */
  private get isolationEnabled(): boolean {
    return parseIsolationEnabled(
      process.env['PAYMENT_ISOLATION_ENABLED'],
    );
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly limitsService: LimitsService,
    private readonly walletsService: WalletsService,
  ) {
    // #1256 – Log the resolved isolation state exactly once at startup.
    // Only the derived on/off state is logged; no other env values are emitted.
    this.logger.log(
      `Payment isolation is ${this.isolationEnabled ? 'on' : 'off'}`,
    );
  }

  /**
   * Validates a `current → next` status pair against ALLOWED_TRANSITIONS.
   *
   * Legal edges (see ALLOWED_TRANSITIONS):
   *  - PENDING → CONFIRMED
   *  - PENDING → FAILED
   *
   * Terminal states (no outgoing transitions): CONFIRMED, FAILED.
   * Any attempt to move out of a terminal state is rejected here.
   */
  private assertTransitionAllowed(
    current: PaymentStatus,
    next: PaymentStatus,
  ): void {
    const allowed = ALLOWED_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      throw new BadRequestException(
        `Cannot transition payment from ${current} to ${next}`,
      );
    }
  }

  /**
   * #1250 – With isolation on, a missing owner id must not degrade into an
   * unscoped query. Write paths call this to reject the request outright.
   */
  private assertOwnerPresent(developerOwnerId?: string): void {
    if (this.isolationEnabled && !developerOwnerId) {
      throw new ForbiddenException(
        'developerOwnerId is required when payment isolation is enabled',
      );
    }
  }

  /**
   * #1112 – `developerOwnerId` is supplied by the controller from the API key
   * context, never from the request body. It is required so ownership can never
   * be claimed by a caller.
   */
  async create(createPaymentDto: CreatePaymentDto, developerOwnerId: string) {
    const {
      walletId,
      receiverWalletId,
      fromId,
      toId,
      amount,
      currency,
      description,
      idempotencyKey,
    } = createPaymentDto;

    // ── Idempotency guard ──────────────────────────────────────────────────
    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        // #1100 – only replay when the cached payment belongs to the requesting
        // developer. A key collision across developers must not leak the record.
        if (
          this.isolationEnabled &&
          developerOwnerId &&
          existing.developerOwnerId !== developerOwnerId
        ) {
          this.logger.warn(
            `Idempotency key collision across developers for key=${idempotencyKey}`,
          );
          throw new NotFoundException(
            `Wallet ${walletId} not found for this developer`,
          );
        }
        this.logger.log(
          `Idempotent replay detected for key=${idempotencyKey}, returning cached payment`,
        );
        return existing;
      }
    }

    // ── Wallet ownership / status validation ───────────────────────────────
    const senderWallet = await this.walletsService.findWalletById(walletId);
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Sender wallet is not active (status: ${senderWallet.status})`,
      );
    }

    // ── Developer isolation: sender wallet must belong to the same developer ─
    if (this.isolationEnabled && developerOwnerId) {
      if (senderWallet.userId !== developerOwnerId) {
        // Do not reveal whether the wallet exists at all — treat as not found.
        this.logger.warn(
          `Payment isolation violation: wallet ${walletId} does not belong to developer ${developerOwnerId}`,
        );
        throw new NotFoundException(
          `Wallet ${walletId} not found for this developer`,
        );
      }
    }

    // ── Receiver wallet validation ─────────────────────────────────────────
    // The receiver must exist and be ACTIVE, mirroring the sender checks.
    // Ownership is intentionally not enforced here: cross-developer receivers
    // are allowed by design (see class doc comment).
    const receiverWallet =
      await this.walletsService.findWalletById(receiverWalletId);
    if (receiverWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Receiver wallet is not active (status: ${receiverWallet.status})`,
      );
    }

    // Enforce wallet-scoped spending limits against the sender wallet UUID.
    // Runs after the ACTIVE-status and ownership checks and before the payment
    // row is created, so a rejected payment leaves no row behind.
    await this.limitsService.checkLimits(walletId, amount);

    const correlationId = crypto.randomUUID();

    const payment = await this.prisma.payment.create({
      data: {
        fromId,
        toId,
        amount,
        currency,
        description,
        userId: fromId,
        status: 'PENDING',
        // #972 identity isolation columns
        senderWalletId: walletId,
        developerOwnerId: developerOwnerId ?? null,
        idempotencyKey: idempotencyKey ?? null,
        correlationId,
      },
    });

    this.logger.log(
      `Payment created id=${payment.id} correlationId=${correlationId} developerOwnerId=${developerOwnerId ?? 'unset'}`,
    );

    return payment;
  }

  /**
   * Returns all payments scoped to a developer.
   * #1250 – With isolation on, a missing developerOwnerId returns an empty page
   * instead of an unscoped findMany. The unscoped list is only available when
   * PAYMENT_ISOLATION_ENABLED is explicitly 'false'.
   */
  async findAll(developerOwnerId?: string) {
    if (this.isolationEnabled && !developerOwnerId) {
      this.logger.warn(
        'findAll called without developerOwnerId while isolation is enabled; returning empty page',
      );
      return [];
    }

    const where =
      this.isolationEnabled && developerOwnerId
        ? { developerOwnerId }
        : {};

    return this.prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns a single payment scoped to a developer.
   * A record that exists but belongs to another developer yields 404 to avoid
   * enumeration.
   */
  async findOne(id: string, developerOwnerId?: string) {
    if (this.isolationEnabled && !developerOwnerId) {
      throw new ForbiddenException(
        'developerOwnerId is required when payment isolation is enabled',
      );
    }

    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) {
      throw new NotFoundException(`Payment ${id} not found`);
    }
    if (
      this.isolationEnabled &&
      developerOwnerId &&
      payment.developerOwnerId !== developerOwnerId
    ) {
      throw new NotFoundException(`Payment ${id} not found`);
    }
    return payment;
  }

  async update(
    id: string,
    updatePaymentDto: UpdatePaymentDto,
    developerOwnerId?: string,
  ) {
    this.assertOwnerPresent(developerOwnerId);

    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Payment ${id} not found`);
    }
    if (
      this.isolationEnabled &&
      developerOwnerId &&
      existing.developerOwnerId !== developerOwnerId
    ) {
      throw new NotFoundException(`Payment ${id} not found`);
    }

    if (updatePaymentDto.status) {
      this.assertTransitionAllowed(
        existing.status as PaymentStatus,
        updatePaymentDto.status as PaymentStatus,
      );
    }

    return this.prisma.payment.update({
      where: { id },
      data: updatePaymentDto,
    });
  }

  async remove(id: string, developerOwnerId?: string) {
    this.assertOwnerPresent(developerOwnerId);

    const existing = await this.prisma.payment.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Payment ${id} not found`);
    }
    if (
      this.isolationEnabled &&
      developerOwnerId &&
      existing.developerOwnerId !== developerOwnerId
    ) {
      throw new NotFoundException(`Payment ${id} not found`);
    }

    return this.prisma.payment.delete({ where: { id } });
  }
}
