import { RecoveryStatus } from '../domain/recovery.model';

/**
 * RecoveryRequest entity class.
 */
export class RecoveryRequest {
  id: string;
  walletId: string;
  requester: string;
  status: RecoveryStatus;
  metadata?: any | null;
  createdAt: Date;
  updatedAt: Date;
}
