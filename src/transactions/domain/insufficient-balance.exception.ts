import { UnprocessableEntityException } from '@nestjs/common';

export class InsufficientBalanceException extends UnprocessableEntityException {
  constructor(
    walletId: string,
    required: string,
    available: string,
    assetCode?: string | null,
  ) {
    const asset = assetCode ?? 'XLM';
    super(
      `Insufficient balance for wallet ${walletId}: required ${required} ${asset}, available ${available} ${asset}`,
    );
  }
}

/**
 * Raised when Stellar Horizon itself rejects a submitted transaction because
 * the source account can't cover the payment or fee (tx_insufficient_balance,
 * op_underfunded). Kept distinct from other Horizon rejections (bad sequence,
 * bad auth, malformed envelope, ...) so callers can tell "you need more funds"
 * apart from a generic 400.
 */
export class HorizonInsufficientBalanceException extends UnprocessableEntityException {
  constructor(transactionId: string, horizonResultCode: string) {
    super(
      `Transaction ${transactionId} rejected by Horizon due to insufficient balance (${horizonResultCode})`,
    );
  }
}
