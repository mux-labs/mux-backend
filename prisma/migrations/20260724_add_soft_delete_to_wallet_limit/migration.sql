-- Add soft-delete support to WalletLimit
-- Soft-delete keeps rows for audit/recovery while excluding them from active policy.
-- deletedAt IS NULL  => active limit
-- deletedAt IS NOT NULL => soft-deleted limit (retained, never hard-deleted)
ALTER TABLE "WalletLimit" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Default to active (NULL) so existing rows remain live after migration.
ALTER TABLE "WalletLimit" ALTER COLUMN "deletedAt" DROP DEFAULT;

-- Index for soft-delete aware queries (active-only lookups and purge/audit scans).
CREATE INDEX "WalletLimit_deletedAt_idx" ON "WalletLimit"("deletedAt");

-- Composite index for the common access path: active limits per wallet.
CREATE INDEX "WalletLimit_walletId_deletedAt_idx" ON "WalletLimit"("walletId", "deletedAt");
