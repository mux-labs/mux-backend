/**
 * Payment money-path model: the types every payment entrypoint speaks.
 *
 * The dry-run contract (`docs/PAYMENT-DRY-RUN.md`) is deliberately expressed
 * here rather than as a separate service: a dry-run is the *same* intent run
 * through the same validation, authz, and idempotency checks, differing only in
 * whether the final (irreversible) submission step is allowed to happen.
 */

/** Networks a payment may target. */
export const PaymentNetwork = {
  TESTNET: 'TESTNET',
  MAINNET: 'MAINNET',
} as const;

export type PaymentNetwork =
  (typeof PaymentNetwork)[keyof typeof PaymentNetwork];

/** Outcome of an executed payment intent. Carries no key material. */
export const PaymentStatus = {
  /** Live payment submitted to the network. */
  SUBMITTED: 'SUBMITTED',
  /** Dry-run: validated and simulated; nothing was submitted or persisted. */
  DRY_RUN: 'DRY_RUN',
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Roles the money path accepts. Deny-by-default: everything else is refused. */
export type PaymentRole = 'owner' | 'delegate' | 'guardian' | 'api-key' | 'jwt';

/**
 * Authenticated principal for a payment.
 *
 * Resolved server-side by the auth guard (owner / delegate / guardian /
 * API-key / JWT). A client can never assert any of these fields: they are
 * read from the request context the guard populated, never from the body,
 * query string, or headers.
 */
export interface PaymentActor {
  subjectId: string;
  role: PaymentRole;
  /** Correlation id for tracing this request across logs and services. */
  correlationId: string;
  /** Set when the delegate credential has been revoked since it was issued. */
  delegateRevoked?: boolean;
}

/** A payment request as received from the entrypoint. */
export interface PaymentIntent {
  /** Wallet debited by the payment. */
  walletId: string;
  /** Wallet credited by the payment. */
  receiverWalletId: string;
  /** Positive decimal string with at most 7 fractional digits. */
  amount: string;
  /** Stellar asset code (e.g. `XLM`). Defaults to the native asset. */
  assetCode?: string;
  /** Target network. Defaults to the deployment's configured network. */
  network?: PaymentNetwork;
  /** Request a dry-run: validate and simulate, never submit. */
  dryRun?: boolean;
  /**
   * Idempotency key for this write. Required for live payments and dry-runs
   * alike (`IDEMPOTENCY_KEY_REQUIRED` when missing).
   */
  idempotencyKey?: string;
}

/** Fully-normalized intent after validation. */
export interface ResolvedPaymentIntent {
  walletId: string;
  receiverWalletId: string;
  amount: string;
  assetCode: string;
  network: PaymentNetwork;
  dryRun: boolean;
}

/**
 * The one place a payment becomes irreversible.
 *
 * `PaymentMoneyPathService` calls `submit` exactly once per live payment and
 * never for a dry-run, a killed switch, or a disabled mainnet flag. No default
 * implementation ships: a deployment binds this token to its custody/Horizon
 * layer, so an unbound service refuses to construct rather than "succeeding"
 * without ever reaching the chain.
 */
export interface PaymentSubmissionPort {
  submit(request: {
    correlationId: string;
    walletId: string;
    receiverWalletId: string;
    amount: string;
    assetCode: string;
    network: PaymentNetwork;
  }): Promise<{ transactionHash: string }>;
}

/**
 * A stored result for a completed `(principal, idempotency key)` pair.
 *
 * The fingerprint is a sha256 digest of the normalized request, so the store
 * never holds raw caller input — only a digest it can compare.
 */
export interface StoredPaymentResult {
  /** Canonical fingerprint of the original request body. */
  fingerprint: string;
  /** The original response, replayed verbatim on a duplicate request. */
  result: PaymentExecutionResult;
}

/**
 * Outcome of an idempotency reservation attempt.
 *
 * `reserve` → `complete`/`release` is the exactly-once protocol: the key is
 * reserved *before* submission, so two concurrent requests with the same key
 * can never both reach the submission port, and a failed submission releases
 * the key so the documented "safe to retry" behaviour holds.
 */
export type PaymentIdempotencyReservation =
  /** A completed result exists: replay it verbatim. */
  | { kind: 'replay'; stored: StoredPaymentResult }
  /** The key is now reserved for this request; `complete` or `release` it. */
  | { kind: 'reserved'; reservationId: string }
  /** Same key, different payload: refuse with `IDEMPOTENCY_CONFLICT`. */
  | { kind: 'mismatch' }
  /** Same key, another request is still in flight: refuse (do not race). */
  | { kind: 'in_flight' };

/**
 * The idempotency surface the money path depends on.
 *
 * Keys are scoped by principal: a key issued by one subject can never be
 * replayed by another, so keys cannot be used to read or overwrite a foreign
 * result. Fail-closed: any store failure is treated as an outage (503), never
 * as "no record found".
 */
export interface PaymentIdempotencyStore {
  reserve(
    subjectId: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<PaymentIdempotencyReservation>;
  /** Persist the final result, releasing the reservation as complete. */
  complete(
    reservationId: string,
    result: PaymentExecutionResult,
    fingerprint: string,
  ): Promise<void>;
  /** Drop a reservation after a failed attempt so a retry may proceed. */
  release(reservationId: string): Promise<void>;
}

/** Simulated checks reported for a dry-run. */
export interface PaymentDryRunChecks {
  senderWallet: 'ACTIVE';
  receiverWallet: 'FOUND';
  paymentLimits: 'PASSED';
  submission: 'SKIPPED';
}

/** Result envelope of an executed payment intent. */
export interface PaymentExecutionResult {
  paymentId: string;
  status: PaymentStatus;
  dryRun: boolean;
  network: PaymentNetwork;
  walletId: string;
  receiverWalletId: string;
  amount: string;
  assetCode: string;
  /** Transaction hash, present only for a submitted live payment. */
  transactionHash?: string;
  /** Dry-run preview: the payment that *would* have been created. */
  preview?: {
    walletId: string;
    receiverWalletId: string;
    amount: string;
    assetCode: string;
    /** Always `PaymentStatus.DRY_RUN`: a preview never describes a live write. */
    status: PaymentStatus;
  };
  /** Dry-run checks. `submission` is always `SKIPPED`. */
  checks?: PaymentDryRunChecks;
  correlationId: string;
  /** True when this response was replayed from the idempotency store. */
  replayed: boolean;
  /** ISO-8601 timestamp; dry-runs report when the simulation ran. */
  simulatedAt?: string;
}

/** DI token for the Horizon/custody submission port. */
export const PAYMENT_SUBMISSION_PORT = Symbol('PAYMENT_SUBMISSION_PORT');

/** DI token for the payment idempotency store. */
export const PAYMENT_IDEMPOTENCY_STORE = Symbol('PAYMENT_IDEMPOTENCY_STORE');

/** Maximum accepted length of an `Idempotency-Key`, in characters. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** Upper bound on a serialized payment intent, in bytes (griefing guard). */
export const MAX_PAYMENT_INTENT_BYTES = 8192;
