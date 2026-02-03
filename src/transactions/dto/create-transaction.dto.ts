export class TransactionAssetDto {
  type: string; // AssetType enum as string
  code?: string; // e.g., "USDC" (null for native XLM)
  issuer?: string; // Issuer public key (null for native XLM)
}

export class CreateTransactionDto {
  amount: string; // Stored as string for precision
  asset: TransactionAssetDto;
  senderWalletId: string;
  receiverWalletId?: string;
  metadata?: Record<string, any>;
}
