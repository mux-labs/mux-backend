-- Add soft-delete support to WalletLimit
ALTER TABLE "WalletLimit" ADD COLUMN "deletedAt" TIMESTAMP;

-- Create index for soft-delete queries
CREATE INDEX "WalletLimit_deletedAt_idx" ON "WalletLimit"("deletedAt");
