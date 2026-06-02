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
  /** Extras block returned on 400 responses */
  extras?: {
    result_codes?: {
      transaction?: string;
      operations?: string[];
    };
  };
}

/**
 * Maps a Horizon transaction result to an internal TransactionStatus.
 *
 * Pure function — no side effects.
 */
export function mapHorizonResultToStatus(
  result: HorizonTransactionResult,
): TransactionStatus {
  // Successful submission
  if (result.successful === true) {
    return TransactionStatus.CONFIRMED;
  }

  const txCode =
    result.result_code ??
    result.extras?.result_codes?.transaction ??
    '';

  switch (txCode) {
    case 'tx_success':
      return TransactionStatus.CONFIRMED;

    // Fee-bump outcomes that indicate the inner tx succeeded
    case 'tx_fee_bump_inner_success':
      return TransactionStatus.CONFIRMED;

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
