-- Migration: network-scoped API keys (#977)
--
-- The API key prefix already encodes the environment (mux_live_ / mux_test_).
-- This migration adds an explicit `network` column to ApiKey so the mismatch
-- check can be enforced at the DB level in addition to the application layer,
-- and enables future per-network key scoping in policy enforcement.

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "network" "WalletNetwork";

-- CreateIndex
CREATE INDEX "ApiKey_network_idx" ON "ApiKey"("network");

-- Backfill: bind existing keys to the network of their owning wallet so that
-- network scoping is fail-closed (a key can only be used against the network
-- its wallet belongs to). Keys whose wallet network cannot be resolved are
-- left NULL and are therefore denied by the guard (deny-by-default).
UPDATE "ApiKey" AS k
SET "network" = w."network"
FROM "Wallet" AS w
WHERE k."walletId" = w."id"
  AND k."network" IS NULL;

