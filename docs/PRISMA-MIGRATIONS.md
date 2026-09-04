# Prisma migration conventions

## Naming

Every migration must live in its own folder directly under `prisma/migrations/`:

```
prisma/migrations/20260730120000_add_thing/migration.sql
```

- Folder name: `<14-digit-timestamp>_<snake_case_description>` — the format
  `prisma migrate dev` generates by default. The timestamp must be unique and
  should reflect when the migration was authored (`YYYYMMDDHHMMSS`).
- The folder must contain a `migration.sql` file. Don't drop loose `.sql`
  files directly under `prisma/migrations/` — Prisma silently ignores
  anything that isn't inside a migration folder, so a stray file never gets
  applied by `prisma migrate deploy` even though it looks like it's part of
  the migration history.
- `migration_lock.toml` is the only file allowed directly under
  `prisma/migrations/`.

A number of early migrations predate this convention — some use a bare
counter (`0_init`), a short date without a time component
(`20260602_add_wallet_key_version`), or reuse the same 14-digit timestamp as
another migration. They're already applied in every environment, so renaming
them would break Prisma's `_prisma_migrations` tracking table. They're listed
by name in the `LEGACY_EXCEPTIONS` set in `scripts/check-migration-naming.ts`
(the source of truth) and must not be used as a template for new migrations.

## CI check

`pnpm run prisma:check-migrations` (wired into `.github/workflows/ci.yml`)
verifies:

- no loose files under `prisma/migrations/` other than `migration_lock.toml`
- every migration folder contains a `migration.sql`
- every non-legacy folder matches the naming pattern above
- no two non-legacy migrations reuse the same timestamp

Run it locally before opening a PR that touches `prisma/migrations/`:

```
pnpm run prisma:check-migrations
```

The validation logic is unit tested in `scripts/check-migration-naming.spec.ts`
(`pnpm run test:scripts`).
