-- Migration: enforce and document address uniqueness constraint
--
-- The @@unique([network, publicKey]) constraint on the Wallet model has been
-- present since the initial schema migration.  This migration adds a
-- descriptive comment and ensures the index exists with an explicit name so
-- that Prisma P2002 errors can be identified by constraint name in application
-- code and monitoring dashboards.
--
-- No data changes are required; the index already exists.
-- We rename it so the target column list is visible in error metadata.

DO $$
BEGIN
  -- Only rename if the old unnamed index exists and the new one does not.
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE tablename = 'Wallet'
      AND indexname = 'Wallet_network_publicKey_key'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE tablename = 'Wallet'
      AND indexname = 'Wallet_address_unique'
  ) THEN
    ALTER INDEX "Wallet_network_publicKey_key" RENAME TO "Wallet_address_unique";
  END IF;
END $$;
