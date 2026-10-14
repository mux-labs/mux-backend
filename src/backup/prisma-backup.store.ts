import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  BackupRecordCounts,
  BackupSchemaSnapshot,
  BackupStore,
} from './backup.store';

/** Record counts the drill can compute per table. */
interface CountFn {
  count(): Promise<number>;
}

/**
 * Narrow structural view of the Prisma client this adapter uses.
 *
 * Declaring the exact shape the service needs (rather than depending on the
 * generated client types) keeps this unit decoupled from client regeneration
 * and makes every query it performs explicit and reviewable — the same
 * convention `IdempotencyRecordStore` uses. `PrismaService` satisfies it
 * structurally once `prisma generate` has run.
 */
interface PrismaBackupShape {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
  user: CountFn;
  wallet: CountFn;
  transaction: CountFn;
  apiKey: CountFn;
  project: CountFn;
  developer: CountFn;
}

/**
 * Prisma-backed implementation of {@link BackupStore}.
 *
 * Read-only by construction: it exposes no mutation, so a backup drill can
 * never modify data. Any query failure propagates so `BackupService` can fail
 * closed with `BACKUP_DEPENDENCY_UNAVAILABLE` instead of reporting a healthy
 * database it could not actually reach.
 */
@Injectable()
export class PrismaBackupStore implements BackupStore {
  constructor(private readonly prisma: PrismaService) {}

  /** Structural view of the client; see {@link PrismaBackupShape}. */
  private get db(): PrismaBackupShape {
    return this.prisma as unknown as PrismaBackupShape;
  }

  async ping(): Promise<void> {
    await this.db.$queryRaw`SELECT 1`;
  }

  async countRecords(): Promise<BackupRecordCounts> {
    const [users, wallets, transactions, apiKeys, projects, developers] =
      await Promise.all([
        this.db.user.count(),
        this.db.wallet.count(),
        this.db.transaction.count(),
        this.db.apiKey.count(),
        this.db.project.count(),
        this.db.developer.count(),
      ]);
    return { users, wallets, transactions, apiKeys, projects, developers };
  }

  async schema(): Promise<BackupSchemaSnapshot> {
    const tables = await this.db.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    const constraints = await this.db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
    `;
    const indexes = await this.db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM pg_indexes WHERE schemaname = 'public'
    `;
    return {
      tables: tables.map((row) => row.table_name),
      foreignKeys: Number(constraints[0]?.count ?? 0),
      indexes: Number(indexes[0]?.count ?? 0),
    };
  }
}
