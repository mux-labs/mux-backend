import { TransactionStatus } from './domain/transaction.model';

/**
 * Subset of the Horizon transaction result used for status mapping.
 */
export interface HorizonTransactionResult {
  /** Present on successful submission */
  hash?: string;
  /** Present on successful submission */
  ledger?: number;
  /** Fee charged in stroops (string from Horizon) */
  fee_charged?: string;
  /** true when Horizon accepted the transaction */
  successful?: boolean;
  /** Horizon result_code string, e.g. "tx_success", "tx_failed" */
  result_code?: string;
  /** HTTP status code returned by Horizon (used to detect 202 Accepted / in-flight) */
  http_status?: number;
  /** Extras block returned on 400 responses */
  extras?: {
    result_codes?: {
      transaction?: string;
      operations?: string[];
    };
  };
}

/** Transaction-level code Horizon returns when the source can't cover amount + fee. */
const TX_INSUFFICIENT_BALANCE_CODE = 'tx_insufficient_balance';
/** Operation-level code Horizon returns when a payment op exceeds the sender's spendable balance. */
const OP_UNDERFUNDED_CODE = 'op_underfunded';

/**
 * True when a Horizon rejection is specifically due to the source account
 * lacking sufficient balance, as opposed to any other rejection reason
 * (bad sequence, bad auth, malformed envelope, etc.).
 */
export function isInsufficientBalanceResult(
  result: HorizonTransactionResult,
  txCode: string,
): boolean {
  if (txCode === TX_INSUFFICIENT_BALANCE_CODE) {
    return true;
  }
  return (result.extras?.result_codes?.operations ?? []).includes(
    OP_UNDERFUNDED_CODE,
  );
}

/**
 * Maps a Horizon transaction result to an internal TransactionStatus.
 *
 * #498: Added SUBMITTED mapping for in-flight transactions:
 * - HTTP 202 Accepted — Horizon received the transaction but it hasn't been
 *   included in a ledger yet.
 * - result_code "tx_queued" — transaction is queued for future ledger inclusion.
 *
 * Pure function — no side effects.
 */
export function mapHorizonResultToStatus(
  result: HorizonTransactionResult,
): TransactionStatus {
  // #498: HTTP 202 means Horizon accepted but it's still in-flight (not yet ledger-confirmed)
  if (result.http_status === 202) {
    return TransactionStatus.SUBMITTED;
  }

  // Successful submission with ledger confirmation
  if (result.successful === true) {
    return TransactionStatus.CONFIRMED;
  }

  const txCode =
    result.result_code ?? result.extras?.result_codes?.transaction ?? '';

  switch (txCode) {
    case 'tx_success':
      return TransactionStatus.CONFIRMED;

    // Fee-bump outcomes that indicate the inner tx succeeded
    case 'tx_fee_bump_inner_success':
      return TransactionStatus.CONFIRMED;

    // #498: In-flight / queued states map to SUBMITTED
    // tx_queued is used by some Horizon implementations to indicate the
    // transaction has been received and is pending ledger inclusion.
    case 'tx_queued':
      return TransactionStatus.SUBMITTED;

    // Definitive failures
    case 'tx_failed':
    case 'tx_too_early':
    case 'tx_too_late':
    case 'tx_missing_operation':
    case 'tx_bad_seq':
    case 'tx_bad_auth':
    case 'tx_insufficient_balance':
    case 'tx_no_source_account':
    case 'tx_insufficient_fee':
    case 'tx_bad_auth_extra':
    case 'tx_internal_error':
    case 'tx_not_supported':
    case 'tx_fee_bump_inner_failed':
    case 'tx_bad_sponsorship':
    case 'tx_bad_min_seq_age_or_gap':
    case 'tx_malformed':
      return TransactionStatus.FAILED;

    default:
      // Unknown / unexpected result code — treat as failed to avoid stuck PENDING
      return TransactionStatus.FAILED;
  }
}
