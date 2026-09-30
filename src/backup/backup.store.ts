/** Record counts collected for backup verification. */
export interface BackupRecordCounts {
  users: number;
  wallets: number;
  transactions: number;
  apiKeys: number;
  projects: number;
  developers: number;
}

/** Schema snapshot used by the restore drill. */
export interface BackupSchemaSnapshot {
  /** Table names present in the target schema. */
  tables: string[];
  /** Foreign key constraints present. */
  foreignKeys: number;
  /** Indexes present. */
  indexes: number;
}

/**
 * DI token for the read-only database surface the backup module needs.
 *
 * Declaring the exact shape the module uses (rather than depending on the
 * generated Prisma client types) keeps `BackupService` unit-testable against a
 * fake and makes every query it performs explicit and reviewable.
 */
export const BACKUP_STORE = Symbol('BACKUP_STORE');

/** Tables the restore drill expects to find. */
export const REQUIRED_BACKUP_TABLES: readonly string[] = [
  'users',
  'wallets',
  'transactions',
  'api_keys',
  'projects',
  'developers',
];

/** Number of rows the drill expects to be able to count per table. */
export const COUNTED_BACKUP_TABLES: readonly (keyof BackupRecordCounts)[] = [
  'users',
  'wallets',
  'transactions',
  'apiKeys',
  'projects',
  'developers',
];

/** Read-only database operations backing health, metadata, and drills. */
export interface BackupStore {
  /** Cheap round-trip used by the health check. */
  ping(): Promise<void>;
  /** Row counts for the documented tables. */
  countRecords(): Promise<BackupRecordCounts>;
  /** Schema snapshot (tables, foreign keys, indexes). */
  schema(): Promise<BackupSchemaSnapshot>;
}
