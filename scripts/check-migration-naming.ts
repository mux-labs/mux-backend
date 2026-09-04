import * as fs from 'fs';
import * as path from 'path';

export const MIGRATIONS_DIR = path.join(__dirname, '..', 'prisma', 'migrations');

/** Files permitted to sit directly under prisma/migrations/ (not inside a migration folder). */
export const ALLOWED_TOP_LEVEL_FILES = new Set(['migration_lock.toml']);

/**
 * Migration folders created before this naming convention was enforced.
 * They are already applied to real databases, so they can't be renamed
 * without breaking Prisma's `_prisma_migrations` tracking table. New
 * migrations must not be added to this list.
 */
export const LEGACY_EXCEPTIONS = new Set([
  '0_init',
  '1_add_wallet_limit',
  '20260601000000_add_spending_limits',
  '20260601000000_add_transaction_idempotency_key',
  '20260601000000_add_wallet_successor_id',
  '20260602_add_wallet_key_version',
  '20260723_add_asset_code_to_payment',
  '20260724000000_add_user_default_network',
  '20260724000000_add_user_last_login_metadata',
  '20260724_add_soft_delete_to_wallet_limit',
  '20260729000000_add_maintenance_state',
  '20260729000000_add_wallet_nickname',
]);

const NAME_PATTERN = /^\d{14}_[a-z0-9_]+$/;

export interface MigrationEntry {
  name: string;
  isDirectory: boolean;
  hasMigrationSql: boolean;
}

/**
 * Pure validation over a directory listing so the rules can be unit tested
 * without touching the filesystem.
 */
export function validateMigrationEntries(entries: MigrationEntry[]): string[] {
  const errors: string[] = [];
  const seenTimestamps = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory) {
      if (!ALLOWED_TOP_LEVEL_FILES.has(entry.name)) {
        errors.push(
          `"${entry.name}" is a loose file directly under prisma/migrations/. ` +
            `Every migration must live in its own "<timestamp>_<name>/migration.sql" folder.`,
        );
      }
      continue;
    }

    if (!entry.hasMigrationSql) {
      errors.push(
        `"${entry.name}/" is missing a migration.sql file.`,
      );
    }

    if (LEGACY_EXCEPTIONS.has(entry.name)) {
      continue;
    }

    if (!NAME_PATTERN.test(entry.name)) {
      errors.push(
        `"${entry.name}" does not match the required "<14-digit-timestamp>_<snake_case_name>" ` +
          `format (e.g. 20260730120000_add_thing). See docs/PRISMA-MIGRATIONS.md.`,
      );
      continue;
    }

    const timestamp = entry.name.slice(0, 14);
    const clash = seenTimestamps.get(timestamp);
    if (clash) {
      errors.push(
        `"${entry.name}" reuses timestamp ${timestamp} already used by "${clash}". ` +
          `Migration timestamps must be unique and monotonically increasing.`,
      );
    } else {
      seenTimestamps.set(timestamp, entry.name);
    }
  }

  return errors;
}

function readEntries(dir: string): MigrationEntry[] {
  return fs.readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    const isDirectory = fs.statSync(full).isDirectory();
    const hasMigrationSql =
      isDirectory && fs.existsSync(path.join(full, 'migration.sql'));
    return { name, isDirectory, hasMigrationSql };
  });
}

function main() {
  const entries = readEntries(MIGRATIONS_DIR);
  const errors = validateMigrationEntries(entries);

  if (errors.length > 0) {
    console.error('Prisma migration naming check failed:\n');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error(
      '\nSee docs/PRISMA-MIGRATIONS.md for the naming convention and how to fix this.',
    );
    process.exit(1);
  }

  console.log(`Prisma migration naming check passed (${entries.length} entries).`);
}

if (require.main === module) {
  main();
}
