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
