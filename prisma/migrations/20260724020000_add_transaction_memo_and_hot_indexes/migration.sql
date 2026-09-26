-- Add searchable memo field to Transaction (#544)
ALTER TABLE "Transaction" ADD COLUMN "memo" TEXT;

-- Hot-path indexes for wallet and transaction queries (#547)
CREATE INDEX "Transaction_senderWalletId_createdAt_idx" ON "Transaction"("senderWalletId", "createdAt");
CREATE INDEX "Transaction_receiverWalletId_createdAt_idx" ON "Transaction"("receiverWalletId", "createdAt");
CREATE INDEX "Wallet_status_createdAt_idx" ON "Wallet"("status", "createdAt");

-- Transaction idempotency (#879)
-- Add a client-supplied idempotency key so replayed/concurrent transaction
-- creation requests resolve to the original transaction instead of creating
-- a duplicate. Nullable to preserve existing rows; uniqueness is scoped per
-- sender wallet so distinct wallets may reuse the same key value.
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;

-- Enforce idempotency at the database level: a given (senderWalletId,
-- idempotencyKey) pair can only ever map to a single transaction. Partial
-- index keeps legacy rows (NULL key) out of the constraint.
CREATE UNIQUE INDEX "Transaction_senderWalletId_idempotencyKey_key"
  ON "Transaction"("senderWalletId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- Hot index to make idempotency lookups (and replay detection) fast on the
-- money path without a full table scan.
CREATE INDEX "Transaction_idempotencyKey_idx"
  ON "Transaction"("idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
