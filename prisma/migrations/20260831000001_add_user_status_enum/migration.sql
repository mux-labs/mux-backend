-- Migration: add UserStatus enum and migrate User.status from String to the new enum.
--
-- The existing values stored in production ('ACTIVE', 'INACTIVE', 'SUSPENDED', 'DISABLED')
-- must all be valid enum members before ALTER COLUMN executes.  Any row with an
-- unrecognised value will cause the migration to fail fast, preventing silent data loss.
--
-- Safe migration order:
--   1. Create the enum type.
--   2. Coerce any legacy 'INACTIVE' values to 'DISABLED' (INACTIVE is not in the new enum;
--      the domain entity never used it, but old seeds/manual writes may have stored it).
--   3. Alter the column to use the new type with explicit USING cast.
--   4. Restore the DEFAULT.

-- Step 1: Create the enum.
CREATE TYPE "UserStatus" AS ENUM (
  'PROVISIONING',
  'ACTIVE',
  'RECOVERY_PENDING',
  'SUSPENDED',
  'DISABLED'
);

-- Step 2: Normalise any legacy 'INACTIVE' rows → 'DISABLED' before the ALTER.
--   'INACTIVE' was an undocumented legacy value that behaved identically to
--   'DISABLED' (both rejected authentication with 403 Forbidden).
UPDATE "User"
SET status = 'DISABLED'
WHERE status = 'INACTIVE';

-- Fail fast: abort if any unrecognised status values remain that cannot be cast.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE status NOT IN ('PROVISIONING', 'ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED', 'DISABLED')
  ) THEN
    RAISE EXCEPTION
      'Migration 20260831000001: "User".status contains values outside the UserStatus enum. '
      'Inspect and coerce them manually before re-running this migration.';
  END IF;
END $$;

-- Step 3: Alter the column type with an explicit USING cast.
ALTER TABLE "User"
  ALTER COLUMN "status" TYPE "UserStatus"
  USING status::"UserStatus";

-- Step 4: Restore the default now that the column type is known.
ALTER TABLE "User"
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE'::"UserStatus";
