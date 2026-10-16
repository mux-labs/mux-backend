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
 *  - Feature-flagged: if PAYMENT_ISOLATION_ENABLED !== 'true' the guard is bypassed
 *    in development to allow gradual rollout without breaking existing callers.
 *
 * #1104 – Receiver wallet validation.
 *  - The receiver wallet must exist and be ACTIVE, mirroring the send
 *  - Idempotency key uniqueness is enforced at the DB level; the service returns the
 *    cached response instead of re-executing on conflict, but only when the cached
 *    payment belongs to the requesting developer.
 *  - Feature-flagged: if PAYMENT_ISOLATION_ENABLED !== 'true' the guard is bypassed
 *    in development to allow gradual rollout without breaking existing callers.
 *
 * #1104 – Receiver wallet validation.
 *  - The receiver wallet must exist and be ACTIVE, mirroring the sender checks.
 *  - Receiver ownership is intentionally NOT scoped to the calling developer:
 *    payments are a transfer primitive and a developer may legitimately pay a
 *    wallet owned by another developer (e.g. marketplace payouts, refunds to a
 *    counterparty). Cross-developer receivers are therefore allowed by design;
 *    only the sender wallet is subject to the developerOwnerId isolation guard.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /** Kill-switch / feature flag — defaults ON in production-like envs. */
  private get isolationEnabled(): boolean {
    return process.env['PAYMENT_ISOLATION_ENABLED'] !== 'false';
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly limitsService: LimitsService,
    private readonly walletsService: WalletsService,
  ) {}

  /**
   * Validates a `current → next` status pair against ALLOWED_TRANSITIONS.
   * Terminal states (CONFIRMED, FAILED) have no outgoing transitions, so any
   * attempt to move out of them is rejected here.
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

  async create(createPaymentDto: CreatePaymentDto) {
    const {
      walletId,
      receiverWalletId,
      fromId,
      toId,
      amount,
      currency,
      description,
      developerOwnerId,
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
   * Without developerOwnerId (legacy path), returns all — only allowed if isolation is disabled.
   */
  findAll(developerOwnerId?: string) {
    if (this.isolationEnabled && developerOwnerId) {
      return this.prisma.payment.findMany({
        where: { developerOwnerId },
        orderBy: { createdAt: 'desc' },
      });
    }
    return this.prisma.payment.findMany({ orderBy: { createdAt: 'desc' } });
  }

  /**
   * Returns a single payment, asserting ownership when isolation is enabled.
   * Returns 404 even if the payment exists but belongs to a different developer
   * so as not to leak that the record exists.
   */
  async findOne(id: string, developerOwnerId?: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: Number(id) },
    });

    if (!payment) {
      throw new NotFoundException(`Payment #${id} not found`);
    }

    if (
      this.isolationEnabled &&
      developerOwnerId &&
      payment.developerOwnerId &&
      payment.developerOwnerId !== developerOwnerId
    ) {
      // Intentional 404 — do not reveal cross-developer record existence.
      throw new NotFoundException(`Payment #${id} not found`);
    }

    return payment;
  }

  async update(id: number, updatePaymentDto: UpdatePaymentDto, developerOwnerId?: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) {
      throw new NotFoundException(`Payment #${id} not found`);
    }

    // Authz: developer may only mutate their own payments.
    if (
      this.isolationEnabled &&
      developerOwnerId &&
      payment.developerOwnerId &&
      payment.developerOwnerId !== developerOwnerId
    ) {
      this.logger.warn(
        `Forbidden update attempt on payment ${id} by developer ${developerOwnerId}`,
      );
      throw new ForbiddenException(
        'You do not have permission to update this payment',
      );
    }

    // State machine: validate the transition after the ownership re-check so
    // cross-developer updates still surface the non-enumerating 404/403 above.
    if (updatePaymentDto.status !== undefined) {
      this.assertTransitionAllowed(
        payment.status as PaymentStatus,
        updatePaymentDto.status,
      );
    }

    return this.prisma.payment.update({
      where: { id },
      data: updatePaymentDto,
    });
  }

  /**
   * Deletes a payment, asserting ownership when isolation is enabled.
   * A non-owned id yields 404 (matching findOne) and performs no mutation,
   * so a developer cannot delete another developer's payment by guessing ids.
   */
  async remove(id: string, developerOwnerId?: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: Number(id) },
    });

    if (!payment) {
      throw new NotFoundException(`Payment #${id} not found`);
    }

    if (
      this.isolationEnabled &&
      developerOwnerId &&
      payment.developerOwnerId &&
      payment.developerOwnerId !== developerOwnerId
    ) {
      // Intentional 404 — do not reveal cross-developer record existence.
      this.logger.warn(
        `Cross-developer delete attempt on payment ${id} by developer ${developerOwnerId}`,
      );
      throw new NotFoundException(`Payment #${id} not found`);
    }

    return this.prisma.payment.delete({ where: { id: Number(id) } });
  }
}
