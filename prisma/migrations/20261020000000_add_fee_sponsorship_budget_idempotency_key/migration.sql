-- AlterTable: scope a client idempotency key to a wallet+network budget.
-- NULLs are distinct in a Postgres unique index, so budgets without a key are unaffected.
ALTER TABLE "FeeSponsorshipBudget" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FeeSponsorshipBudget_walletId_network_idempotencyKey_key" ON "FeeSponsorshipBudget"("walletId", "network", "idempotencyKey");
