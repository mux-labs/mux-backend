-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_idempotencyKey_idx" ON "Payment"("idempotencyKey");

-- Enforce exactly-once semantics: idempotency keys must be non-empty when present
-- so replayed/concurrent requests cannot collide on an empty-string key.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_idempotencyKey_not_empty_check"
  CHECK ("idempotencyKey" IS NULL OR length("idempotencyKey") > 0);
