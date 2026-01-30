/**
 * Recovery domain model for account recovery.
 */

export enum RecoveryStatus {
  PENDING = 'PENDING',
  IN_REVIEW = 'IN_REVIEW',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export type RecoveryRequestId = string;

export interface RecoveryRequest {
  id: RecoveryRequestId;
  walletId: string;
  requester: string;
  status: RecoveryStatus;
  metadata?: any | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Explicit, audit-friendly status transition rules for recovery requests.
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<RecoveryStatus, ReadonlySet<RecoveryStatus>>
> = {
  [RecoveryStatus.PENDING]: new Set([
    RecoveryStatus.IN_REVIEW,
    RecoveryStatus.CANCELLED,
  ]),
  [RecoveryStatus.IN_REVIEW]: new Set([
    RecoveryStatus.APPROVED,
    RecoveryStatus.REJECTED,
    RecoveryStatus.CANCELLED,
  ]),
  [RecoveryStatus.APPROVED]: new Set([
    RecoveryStatus.COMPLETED,
    RecoveryStatus.CANCELLED,
  ]),
  [RecoveryStatus.REJECTED]: new Set([]),
  [RecoveryStatus.COMPLETED]: new Set([]),
  [RecoveryStatus.CANCELLED]: new Set([]),
};

export function canTransitionRecoveryStatus(
  from: RecoveryStatus,
  to: RecoveryStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}

export function transitionRecoveryStatus(
  recovery: RecoveryRequest,
  to: RecoveryStatus,
  at: Date = new Date(),
): RecoveryRequest {
  if (recovery.status === to) return recovery;
  if (!canTransitionRecoveryStatus(recovery.status, to)) {
    throw new Error(
      `Invalid recovery status transition: ${recovery.status} -> ${to}`,
    );
  }
  return {
    ...recovery,
    status: to,
    updatedAt: at,
  };
}
