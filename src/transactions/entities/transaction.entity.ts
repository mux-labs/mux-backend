import { TransactionStatus } from '../domain/transaction.model';

/**
 * Persistence-ready Transaction entity for this module.
 */
export class Transaction {
  id: string;
  
  amount: string;
  
  assetType: string;
  assetCode?: string | null;
  assetIssuer?: string | null;
  
  senderWalletId: string;
  receiverWalletId?: string | null;
  
  status: TransactionStatus;
  
  stellarHash?: string | null;
  stellarLedger?: number | null;
  stellarFee?: string | null;
  
  statusChangedAt: Date;
  statusReason?: string | null;
  
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
  failedAt?: Date | null;
  
  metadata?: Record<string, any> | null;
  
  createdAt: Date;
  updatedAt: Date;
}
