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
