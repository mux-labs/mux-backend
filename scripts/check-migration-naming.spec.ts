import { validateMigrationEntries, MigrationEntry } from './check-migration-naming';

function dir(name: string, hasMigrationSql = true): MigrationEntry {
  return { name, isDirectory: true, hasMigrationSql };
}

function file(name: string): MigrationEntry {
  return { name, isDirectory: false, hasMigrationSql: false };
}

describe('validateMigrationEntries', () => {
  it('passes for a well-formed set of migrations plus the lock file', () => {
    const errors = validateMigrationEntries([
      file('migration_lock.toml'),
      dir('20260601000000_add_thing'),
      dir('20260602000000_add_other_thing'),
    ]);
    expect(errors).toEqual([]);
  });

  it('grandfathers known legacy folder names without a timestamp prefix', () => {
    const errors = validateMigrationEntries([
      dir('0_init'),
      dir('1_add_wallet_limit'),
      dir('20260602_add_wallet_key_version'),
    ]);
    expect(errors).toEqual([]);
  });

  it('fails on a loose file directly under prisma/migrations', () => {
    const errors = validateMigrationEntries([
      file('network_scoped_api_keys.sql'),
    ]);
    expect(errors).toEqual([
      expect.stringContaining('network_scoped_api_keys.sql'),
    ]);
  });

  it('fails on a migration folder missing migration.sql', () => {
    const errors = validateMigrationEntries([
      dir('20260601000000_add_thing', false),
    ]);
    expect(errors).toEqual([
      expect.stringContaining('missing a migration.sql file'),
    ]);
  });

  it('fails on a new (non-legacy) folder that does not match the naming pattern', () => {
    const errors = validateMigrationEntries([dir('add_thing_without_timestamp')]);
    expect(errors).toEqual([
      expect.stringContaining('does not match the required'),
    ]);
  });

  it('fails on a non-legacy folder using an unpadded/short timestamp', () => {
    const errors = validateMigrationEntries([dir('20260602_add_wallet_key_version_v2')]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('does not match the required');
  });

  it('fails when two non-legacy migrations reuse the same timestamp', () => {
    const errors = validateMigrationEntries([
      dir('20260601000000_add_thing'),
      dir('20260601000000_add_other_thing'),
    ]);
    expect(errors).toEqual([
      expect.stringContaining('reuses timestamp 20260601000000'),
    ]);
  });

  it('does not flag duplicate timestamps between two legacy-exception folders', () => {
    const errors = validateMigrationEntries([
      dir('0_init'),
      dir('1_add_wallet_limit'),
    ]);
    expect(errors).toEqual([]);
  });
});
