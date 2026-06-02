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
