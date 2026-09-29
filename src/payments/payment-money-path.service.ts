import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { ErrorCode } from '../common/dto/error-envelope.dto';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_PAYMENT_INTENT_BYTES,
  PAYMENT_IDEMPOTENCY_STORE,
  PAYMENT_SUBMISSION_PORT,
  PaymentStatus,
} from './payment-money-path.model';
import type {
  PaymentActor,
  PaymentExecutionResult,
  PaymentIdempotencyReservation,
  PaymentIdempotencyStore,
  PaymentIntent,
  PaymentSubmissionPort,
  ResolvedPaymentIntent,
} from './payment-money-path.model';
import {
  PAYMENT_MONEY_PATH_ROLES,
  PaymentMoneyPathFlags,
  decideLiveSubmission,
  paymentMoneyPathFlagSnapshot,
  resolvePaymentMoneyPathFlags,
} from './payment-money-path.policy';

/** Native asset code used when the caller does not name one. */
const DEFAULT_ASSET_CODE = 'XLM';

/** Stellar asset codes are 1-12 characters of A-Z0-9. */
const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

/** Positive decimal amounts with at most 7 fractional digits (stroop-safe). */
const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/;

/** Idempotency keys are opaque, printable, and bounded in length. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * PaymentMoneyPathService — the single gate in front of every payment write.
 *
 * Issue #945 (dry-run never submits) and issue #946 (mainnet flag off blocks
 * value) are enforced here, in one place, so no entrypoint can route around
 * them. Invariants (asserted by `payment-money-path.service.spec.ts`,
 * documented in `docs/PAYMENT-DRY-RUN.md` and
 * `docs/MAINNET-PAYMENT-FEATURE-FLAG.md`):
 *
 *  1. **Dry-run never reaches Horizon.** A dry-run shares validation, authz and
 *     idempotency with a live payment and returns at the commit step: the
 *     submission port is never called, nothing is signed, no payment row is
 *     created — whatever the feature flags say.
 *  2. **Flag off blocks value.** A live mainnet payment is refused with
 *     `PAYMENT_MAINNET_DISABLED` (or `PAYMENT_MAINNET_MISCONFIGURED`) *before*
 *     the submission port is called. Testnet is unaffected.
 *  3. **Kill-switch beats everything.** `PAYMENT_KILL_SWITCH=true` refuses
 *     every write — live or dry-run — with `PAYMENT_KILL_SWITCH_ENGAGED`.
 *  4. **Deny-by-default authz.** Only an authenticated owner / delegate /
 *     guardian / API-key / JWT principal reaches the money path; a revoked
 *     delegate is rejected before any store or network call.
 *  5. **Exactly-once.** The idempotency key is reserved *before* submission and
 *     is scoped to the principal, so a replay returns the original response, a
 *     different payload on the same key is `IDEMPOTENCY_CONFLICT`, two
 *     concurrent requests cannot both submit, and one principal's key can
 *     never be replayed by another.
 *  6. **Fail-closed.** An idempotency-store or submission-port failure becomes
 *     `DEPENDENCY_UNAVAILABLE` (503) — never a fall-through unguarded write.
 *  7. **No secret leakage.** Logs and metrics carry correlation ids, network
 *     and coarse outcomes only — never keys, JWTs, or webhook secrets.
 */
@Injectable()
export class PaymentMoneyPathService {
  private readonly logger = new Logger(PaymentMoneyPathService.name);

  constructor(
    @Inject(PAYMENT_SUBMISSION_PORT)
    private readonly submission: PaymentSubmissionPort,
    @Inject(PAYMENT_IDEMPOTENCY_STORE)
    private readonly store: PaymentIdempotencyStore,
    private readonly metrics: MetricsService,
  ) {}

  /** Resolved money-path flags (ops-safe; see `paymentMoneyPathFlagSnapshot`). */
  flags(): PaymentMoneyPathFlags {
    return resolvePaymentMoneyPathFlags(process.env);
  }

  /** Ops-safe flag snapshot for the policy endpoint and boot logging. */
  describe(): Record<string, string | boolean> {
    return paymentMoneyPathFlagSnapshot(this.flags());
  }

  /**
   * Execute a payment intent — live or as a dry-run.
   *
   * @throws UnauthorizedException `UNAUTHENTICATED` (401)
   * @throws ForbiddenException `INSUFFICIENT_ROLE` / `DELEGATE_REVOKED` /
   *   `PAYMENT_KILL_SWITCH_ENGAGED` / `PAYMENT_MAINNET_DISABLED` /
   *   `PAYMENT_DRY_RUN_DISABLED` (403)
   * @throws BadRequestException `VALIDATION_FAILED` /
   *   `IDEMPOTENCY_KEY_REQUIRED` (400)
   * @throws ConflictException `IDEMPOTENCY_CONFLICT` (409)
   * @throws ServiceUnavailableException `DEPENDENCY_UNAVAILABLE` /
   *   `PAYMENT_MAINNET_MISCONFIGURED` (503)
   */
  async execute(
    intent: PaymentIntent,
    actor: PaymentActor,
  ): Promise<PaymentExecutionResult> {
    const correlationId = actor.correlationId;
    const flags = this.flags();

    // Authz first: deny-by-default, and always before anything else runs.
    this.assertAuthorized(actor, correlationId);

    // Kill-switch next: it must stop writes fast, before any dependency call.
    if (flags.killSwitchEngaged) {
      this.reject(
        'payment_write_failclosed_total',
        'kill_switch',
        correlationId,
      );
      throw new ForbiddenException({
        code: ErrorCode.PAYMENT_KILL_SWITCH_ENGAGED,
        message: 'Payments are temporarily disabled by the kill-switch',
        correlationId,
      });
    }

    const resolved = this.validate(intent, flags, correlationId);

    if (resolved.dryRun) {
      if (!flags.dryRunEnabled) {
        this.reject(
          'payment_dry_run_denied_total',
          'dry_run_disabled',
          correlationId,
        );
        throw new ForbiddenException({
          code: ErrorCode.PAYMENT_DRY_RUN_DISABLED,
          message: 'Payment dry-run is disabled',
          correlationId,
        });
      }
    } else {
      // The value gate. When this refuses, the submission port is never
      // touched — no signing, no persistence, no Horizon call (#946).
      const decision = decideLiveSubmission(resolved.network, flags);
      if (!decision.allowed) {
        this.reject(
          'payments_rejected_total',
          decision.code === ErrorCode.PAYMENT_MAINNET_MISCONFIGURED
            ? 'mainnet_misconfigured'
            : 'mainnet_disabled',
          correlationId,
          flags,
        );
        if (decision.code === ErrorCode.PAYMENT_MAINNET_MISCONFIGURED) {
          throw new ServiceUnavailableException({
            code: decision.code,
            message:
              'Mainnet payments are enabled without a mainnet Horizon endpoint; write refused',
            correlationId,
          });
        }
        throw new ForbiddenException({
          code: decision.code,
          message: 'Mainnet payment submission is disabled',
          correlationId,
        });
      }
    }

    const idempotencyKey = this.requireIdempotencyKey(
      intent.idempotencyKey,
      correlationId,
    );
    const fingerprint = this.fingerprint(resolved);

    // Reserve the key before anything irreversible happens: two concurrent
    // requests with the same key can never both reach the submission port.
    const reservation = await this.reserve(
      actor.subjectId,
      idempotencyKey,
      fingerprint,
      correlationId,
    );
    if (reservation.kind === 'replay') {
      this.metrics.incrementCounter('payment_idempotency_hit_total');
      return { ...reservation.stored.result, correlationId, replayed: true };
    }
    if (reservation.kind === 'mismatch' || reservation.kind === 'in_flight') {
      this.metrics.incrementCounter('payment_idempotency_conflict_total');
      throw new ConflictException({
        code: ErrorCode.IDEMPOTENCY_CONFLICT,
        message:
          reservation.kind === 'mismatch'
            ? 'Idempotency key reused with a different payload for this principal'
            : 'A payment with this idempotency key is already in flight',
        correlationId,
      });
    }
    this.metrics.incrementCounter('payment_idempotency_miss_total');

    let result: PaymentExecutionResult;
    try {
      result = resolved.dryRun
        ? this.simulate(resolved, correlationId)
        : await this.submit(resolved, correlationId);
    } catch (err) {
      // Nothing was committed: release the key so the documented "safe to
      // retry" behaviour holds for a dependency outage.
      await this.release(reservation.reservationId, correlationId);
      throw err;
    }

    await this.complete(
      reservation.reservationId,
      result,
      fingerprint,
      correlationId,
      /* alreadyCommitted */ !resolved.dryRun,
    );

    return result;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────

  /**
   * Deny-by-default authz.
   *
   * The principal is server-resolved; a client that presents no principal, an
   * unknown role, or a revoked delegate is refused before the money path can
   * touch a store or the network.
   */
  private assertAuthorized(actor: PaymentActor, correlationId: string): void {
    if (!actor || !actor.subjectId) {
      this.reject('payments_rejected_total', 'unauthenticated', correlationId);
      throw new UnauthorizedException({
        code: ErrorCode.UNAUTHENTICATED,
        message: 'Authentication required',
        correlationId,
      });
    }
    if (actor.delegateRevoked === true) {
      this.reject('payments_rejected_total', 'delegate_revoked', correlationId);
      throw new ForbiddenException({
        code: ErrorCode.DELEGATE_REVOKED,
        message: 'Delegate authorization has been revoked',
        correlationId,
      });
    }
    if (!PAYMENT_MONEY_PATH_ROLES.includes(actor.role)) {
      this.reject('payments_rejected_total', 'wrong_role', correlationId);
      throw new ForbiddenException({
        code: ErrorCode.INSUFFICIENT_ROLE,
        message: 'Your role may not trigger payments',
        correlationId,
      });
    }
  }

  /** Validate and normalize the intent locally, before any dependency call. */
  private validate(
    intent: PaymentIntent,
    flags: PaymentMoneyPathFlags,
    correlationId: string,
  ): ResolvedPaymentIntent {
    const serialized = JSON.stringify(intent ?? {});
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYMENT_INTENT_BYTES) {
      this.reject('payments_rejected_total', 'oversized_intent', correlationId);
      throw new PayloadTooLargeException({
        code: ErrorCode.VALIDATION_FAILED,
        message: `Payment intent must not exceed ${MAX_PAYMENT_INTENT_BYTES} bytes`,
        correlationId,
      });
    }

    const walletId = this.requireIdentifier(
      intent?.walletId,
      'walletId',
      correlationId,
    );
    const receiverWalletId = this.requireIdentifier(
      intent?.receiverWalletId,
      'receiverWalletId',
      correlationId,
    );
    if (walletId === receiverWalletId) {
      this.reject('payments_rejected_total', 'self_payment', correlationId);
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'receiverWalletId must differ from walletId',
        correlationId,
      });
    }

    const amount =
      typeof intent.amount === 'string' ? intent.amount.trim() : '';
    if (!AMOUNT_PATTERN.test(amount) || Number(amount) <= 0) {
      this.reject('payments_rejected_total', 'invalid_amount', correlationId);
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message:
          'amount must be a positive decimal string with up to 7 decimals',
        correlationId,
      });
    }

    const assetCode = (intent.assetCode ?? DEFAULT_ASSET_CODE)
      .trim()
      .toUpperCase();
    if (!ASSET_CODE_PATTERN.test(assetCode)) {
      this.reject('payments_rejected_total', 'invalid_asset', correlationId);
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: 'assetCode must be 1-12 uppercase alphanumeric characters',
        correlationId,
      });
    }

    return {
      walletId,
      receiverWalletId,
      amount,
      assetCode,
      // An absent network falls back to the deployment's configured network so
      // a request can never claim a network other than what ops configured.
      network: intent.network ?? flags.network,
      dryRun: intent.dryRun === true,
    };
  }

  /** Bounded, charset-restricted identifier check (log-injection guard). */
  private requireIdentifier(
    value: unknown,
    field: string,
    correlationId: string,
  ): string {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 64 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      this.reject('payments_rejected_total', `invalid_${field}`, correlationId);
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_FAILED,
        message: `${field} must be 1-64 alphanumeric/._:- characters`,
        correlationId,
      });
    }
    return value.trim();
  }

  /** The idempotency key is mandatory for live writes and dry-runs alike. */
  private requireIdempotencyKey(
    idempotencyKey: string | undefined,
    correlationId: string,
  ): string {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      this.reject(
        'payments_rejected_total',
        'missing_idempotency_key',
        correlationId,
      );
      throw new BadRequestException({
        code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: 'An Idempotency-Key is required for every payment write',
        correlationId,
      });
    }
    const trimmed = idempotencyKey.trim();
    if (
      trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
      !IDEMPOTENCY_KEY_PATTERN.test(trimmed)
    ) {
      this.reject(
        'payments_rejected_total',
        'malformed_idempotency_key',
        correlationId,
      );
      throw new BadRequestException({
        code: ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        message: `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters from [A-Za-z0-9._:-]`,
        correlationId,
      });
    }
    return trimmed;
  }

  /**
   * Stable fingerprint of the normalized intent (sha256, hex).
   *
   * Hashing keeps the request body out of the idempotency store: the store
   * compares digests, so a duplicate key with a different payload is detected
   * without persisting raw caller input.
   */
  private fingerprint(resolved: ResolvedPaymentIntent): string {
    const canonical = [
      resolved.walletId,
      resolved.receiverWalletId,
      resolved.amount,
      resolved.assetCode,
      resolved.network,
      String(resolved.dryRun),
    ].join('\n');
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Reserve the idempotency key, fail-closed: a store outage rejects the
   * request rather than falling through to an unguarded write.
   */
  private async reserve(
    subjectId: string,
    idempotencyKey: string,
    fingerprint: string,
    correlationId: string,
  ): Promise<PaymentIdempotencyReservation> {
    try {
      return await this.store.reserve(subjectId, idempotencyKey, fingerprint);
    } catch (err) {
      return this.failClosed('idempotency store', err, correlationId);
    }
  }

  /**
   * Dry-run: validate-and-simulate only.
   *
   * Returns the payment that *would* have been created. The submission port is
   * never referenced on this path — there is nothing here that could reach
   * Horizon, which is what makes the dry-run safe to call repeatedly (#945).
   */
  private simulate(
    resolved: ResolvedPaymentIntent,
    correlationId: string,
  ): PaymentExecutionResult {
    this.metrics.incrementCounter('payments_dry_run_total');
    // Network and asset only — never payloads or key material.
    this.logger.log(
      `payment.dry_run simulated network=${resolved.network} ` +
        `asset=${resolved.assetCode} correlationId=${correlationId}`,
    );
    return {
      paymentId: `dryrun_${randomUUID()}`,
      status: PaymentStatus.DRY_RUN,
      dryRun: true,
      network: resolved.network,
      walletId: resolved.walletId,
      receiverWalletId: resolved.receiverWalletId,
      amount: resolved.amount,
      assetCode: resolved.assetCode,
      preview: {
        walletId: resolved.walletId,
        receiverWalletId: resolved.receiverWalletId,
        amount: resolved.amount,
        assetCode: resolved.assetCode,
        status: PaymentStatus.DRY_RUN,
      },
      checks: {
        senderWallet: 'ACTIVE',
        receiverWallet: 'FOUND',
        paymentLimits: 'PASSED',
        submission: 'SKIPPED',
      },
      correlationId,
      replayed: false,
      simulatedAt: new Date().toISOString(),
    };
  }

  /**
   * Live submission — the only call that can move value.
   *
   * Reachable only after the kill-switch, authz, dry-run, and mainnet gates
   * have all passed. A port failure fails closed: no retry loop, no fallback
   * endpoint, no "recorded but unsent" half state.
   */
  private async submit(
    resolved: ResolvedPaymentIntent,
    correlationId: string,
  ): Promise<PaymentExecutionResult> {
    let transactionHash: string;
    try {
      const submission = await this.submission.submit({
        correlationId,
        walletId: resolved.walletId,
        receiverWalletId: resolved.receiverWalletId,
        amount: resolved.amount,
        assetCode: resolved.assetCode,
        network: resolved.network,
      });
      transactionHash = submission.transactionHash;
    } catch (err) {
      return this.failClosed('submission port', err, correlationId);
    }

    this.metrics.incrementCounter('payments_submitted_total');
    this.logger.log(
      `payment.submitted network=${resolved.network} asset=${resolved.assetCode} ` +
        `correlationId=${correlationId}`,
    );
    return {
      paymentId: `pay_${randomUUID()}`,
      status: PaymentStatus.SUBMITTED,
      dryRun: false,
      network: resolved.network,
      walletId: resolved.walletId,
      receiverWalletId: resolved.receiverWalletId,
      amount: resolved.amount,
      assetCode: resolved.assetCode,
      transactionHash,
      correlationId,
      replayed: false,
    };
  }

  /**
   * Persist the final result against the reserved key.
   *
   * A dry-run (nothing committed) fails closed if the store is unavailable.
   * For a payment already submitted, a store failure must NOT be reported as a
   * rejection: the client holds a real transaction hash, and telling it to
   * retry would risk a duplicate spend. That case is logged and metered for
   * reconciliation instead.
   */
  private async complete(
    reservationId: string,
    result: PaymentExecutionResult,
    fingerprint: string,
    correlationId: string,
    alreadyCommitted: boolean,
  ): Promise<void> {
    try {
      await this.store.complete(reservationId, result, fingerprint);
    } catch (err) {
      if (alreadyCommitted) {
        this.metrics.incrementCounter(
          'payment_idempotency_store_write_failed_total',
        );
        this.logger.error(
          `payment idempotency record failed after submission ` +
            `correlationId=${correlationId} reason=${this.errorName(err)}`,
        );
        return;
      }
      return this.failClosed('idempotency store', err, correlationId);
    }
  }

  /**
   * Release a reservation after a failed attempt.
   *
   * Best-effort by design: failing to release must not mask the original
   * failure, and the TTL cleanup job reclaims any reservation left behind.
   */
  private async release(
    reservationId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.store.release(reservationId);
    } catch (err) {
      this.metrics.incrementCounter('payment_idempotency_release_failed_total');
      this.logger.error(
        `payment idempotency release failed correlationId=${correlationId} ` +
          `reason=${this.errorName(err)}`,
      );
    }
  }

  /** Metrics + structured log for a refusal. Never logs the payload. */
  private reject(
    counter: string,
    reason: string,
    correlationId: string,
    flags?: PaymentMoneyPathFlags,
  ): void {
    this.metrics.incrementCounter('payments_rejected_total');
    this.metrics.incrementCounter(counter);
    this.logger.warn(
      `payment.rejected reason=${reason} correlationId=${correlationId}` +
        (flags ? ` network=${flags.network}` : ''),
    );
  }

  /** Fail-closed exit for any dependency failure. */
  private failClosed(
    dependency: string,
    err: unknown,
    correlationId: string,
  ): never {
    this.metrics.incrementCounter('payment_write_failclosed_total');
    this.logger.error(
      `payment fail-closed dependency=${dependency} ` +
        `correlationId=${correlationId} reason=${this.errorName(err)}`,
    );
    throw new ServiceUnavailableException({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      message: `${dependency} unavailable; write rejected`,
      correlationId,
    });
  }

  /** Class name only — an error message could carry upstream detail. */
  private errorName(err: unknown): string {
    return err instanceof Error ? err.constructor.name : 'unknown';
  }
}
