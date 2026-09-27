-- Payment wallet identity linkage (#895)
-- Links Payment rows to the wallet identities that actually moved funds, so the
-- server remains the source of truth for spends/recovery/admin decisions.
-- Fail-closed: wallet references are validated against "Wallet" and the legacy
-- user-scoped columns become optional only for wallet-linked payments.

ALTER TABLE "Payment" ADD COLUMN "senderWalletId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "receiverWalletId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "transactionId" TEXT;
ALTER TABLE "Payment" ALTER COLUMN "fromId" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "toId" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "userId" DROP NOT NULL;

-- Idempotency: a transaction may back at most one payment row.
CREATE UNIQUE INDEX "Payment_transactionId_key" ON "Payment"("transactionId");

-- Wallet identity linkage: reject dangling wallet references (deny-by-default).
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_senderWalletId_fkey"
  FOREIGN KEY ("senderWalletId") REFERENCES "Wallet"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_receiverWalletId_fkey"
  FOREIGN KEY ("receiverWalletId") REFERENCES "Wallet"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Every payment must be attributable to a wallet identity or a legacy user.
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_identity_linkage_check"
  CHECK (
    "senderWalletId" IS NOT NULL
    OR "receiverWalletId" IS NOT NULL
    OR "userId" IS NOT NULL
  );

-- Lookup paths for wallet-scoped payment history.
CREATE INDEX "Payment_senderWalletId_idx" ON "Payment"("senderWalletId");
CREATE INDEX "Payment_receiverWalletId_idx" ON "Payment"("receiverWalletId");
