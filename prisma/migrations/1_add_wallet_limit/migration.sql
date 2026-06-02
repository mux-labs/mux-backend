-- CreateTable
CREATE TABLE "WalletLimit" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "dailyLimit" DOUBLE PRECISION NOT NULL,
    "perTransactionLimit" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletLimit_walletId_key" ON "WalletLimit"("walletId");

-- CreateIndex
CREATE INDEX "WalletLimit_walletId_idx" ON "WalletLimit"("walletId");

-- AddForeignKey
ALTER TABLE "WalletLimit" ADD CONSTRAINT "WalletLimit_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
