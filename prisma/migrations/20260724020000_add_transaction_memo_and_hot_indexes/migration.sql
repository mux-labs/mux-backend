-- Add searchable memo field to Transaction (#544)
ALTER TABLE "Transaction" ADD COLUMN "memo" TEXT;

-- Hot-path indexes for wallet and transaction queries (#547)
CREATE INDEX "Transaction_senderWalletId_createdAt_idx" ON "Transaction"("senderWalletId", "createdAt");
CREATE INDEX "Transaction_receiverWalletId_createdAt_idx" ON "Transaction"("receiverWalletId", "createdAt");
CREATE INDEX "Wallet_status_createdAt_idx" ON "Wallet"("status", "createdAt");
