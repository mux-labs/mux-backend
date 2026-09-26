-- CreateEnum
CREATE TYPE "LimitPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateTable
CREATE TABLE "SpendingLimit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "perTransactionLimit" DECIMAL(18,8) NOT NULL,
    "periodLimit" DECIMAL(18,8) NOT NULL,
    "period" "LimitPeriod" NOT NULL DEFAULT 'DAILY',
    "assetCode" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpendingLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpendingLimit_userId_idx" ON "SpendingLimit"("userId");

-- CreateIndex
CREATE INDEX "SpendingLimit_isActive_idx" ON "SpendingLimit"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "SpendingLimit_userId_period_assetCode_key" ON "SpendingLimit"("userId", "period", "assetCode");

-- AddForeignKey
ALTER TABLE "SpendingLimit" ADD CONSTRAINT "SpendingLimit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
-- Ledger of enforced spends backing the payments-limits e2e. Each row records a
-- single spend decision so period usage can be summed and replayed requests can
-- be rejected via the unique idempotencyKey (fail-closed on duplicate writes).
CREATE TABLE "SpendingLimitUsage" (
    "id" TEXT NOT NULL,
    "spendingLimitId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,8) NOT NULL,
    "assetCode" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpendingLimitUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpendingLimitUsage_spendingLimitId_createdAt_idx" ON "SpendingLimitUsage"("spendingLimitId", "createdAt");

-- CreateIndex
CREATE INDEX "SpendingLimitUsage_userId_createdAt_idx" ON "SpendingLimitUsage"("userId", "createdAt");

-- CreateIndex
-- Idempotency guard: a replayed spend with the same key cannot be recorded twice.
CREATE UNIQUE INDEX "SpendingLimitUsage_idempotencyKey_key" ON "SpendingLimitUsage"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "SpendingLimitUsage" ADD CONSTRAINT "SpendingLimitUsage_spendingLimitId_fkey" FOREIGN KEY ("spendingLimitId") REFERENCES "SpendingLimit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendingLimitUsage" ADD CONSTRAINT "SpendingLimitUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
