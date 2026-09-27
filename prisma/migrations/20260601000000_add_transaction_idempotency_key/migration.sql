-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Transaction_idempotencyKey_idx" ON "Transaction"("idempotencyKey");

-- CreateIndex
-- Hot index for idempotency lookups scoped by owner and status so replayed/concurrent
-- requests resolve the original transaction without a full-table scan.
CREATE INDEX "Transaction_ownerId_idempotencyKey_idx" ON "Transaction"("ownerId", "idempotencyKey");

-- CreateIndex
-- Hot index for recent transaction reads on the money path (newest-first per owner).
CREATE INDEX "Transaction_ownerId_createdAt_idx" ON "Transaction"("ownerId", "createdAt" DESC);
