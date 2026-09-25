export enum TransactionStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export interface Transaction {
  id: string;
  walletId: string;
  senderWalletId: string;
  amount: string;
  assetCode: string;
  assetType: string;
  status: TransactionStatus;
  memo?: string;
  createdAt: Date;
  updatedAt: Date;
}
