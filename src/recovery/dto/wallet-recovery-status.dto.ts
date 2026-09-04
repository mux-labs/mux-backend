import { RecoveryStatus } from '../domain/recovery.model';

export class WalletRecoveryStatusDto {
  walletId: string;
  hasActiveRecovery: boolean;
  currentStatus?: RecoveryStatus;
  recoveryRequestId?: string;
  lastUpdatedAt?: Date;
}
