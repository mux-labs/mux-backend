-- Enforce "at most one ACTIVE, non-deleted budget per (walletId, network)" in the database.
--
-- The previous full unique index (walletId, network) also blocked a new budget after the
-- old one was CLOSED, so it is replaced by a partial unique index that only covers
-- ACTIVE, non-deleted rows.

-- Step 1: Drop the full unique index created by Prisma's @@unique([walletId, network]).
DROP INDEX IF EXISTS "FeeSponsorshipBudget_walletId_network_key";

-- Step 2: Partial unique index. A concurrent second create for the same wallet and
-- network fails with a unique violation (P2002) instead of inserting a duplicate.
CREATE UNIQUE INDEX "FeeSponsorshipBudget_active_walletId_network_key"
  ON "FeeSponsorshipBudget" ("walletId", "network")
  WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;
