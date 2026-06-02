-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Transaction_idempotencyKey_idx" ON "Transaction"("idempotencyKey");
