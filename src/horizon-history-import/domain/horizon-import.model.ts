/**
 * Domain types for resumable Horizon history import.
 *
 * Mirrors the `HorizonImportCursor` Prisma model's enum/string fields as
 * plain TypeScript so application code does not need to import the
 * generated Prisma client types directly (matching the pattern used by
 * `BalanceSyncStatus` in `balance-indexer/domain/balance.model.ts`).
 */

/** Lifecycle status of the most recent import attempt for a cursor. */
export enum HorizonImportStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

/** Horizon history resource streams supported for resumable import. */
export enum HorizonHistoryResourceType {
  PAYMENTS = 'payments',
  OPERATIONS = 'operations',
  TRANSACTIONS = 'transactions',
}

export interface HorizonHistoryRecord {
  paging_token: string;
  [key: string]: unknown;
}

export interface HorizonHistoryPage {
  _embedded?: {
    records?: HorizonHistoryRecord[];
  };
}
