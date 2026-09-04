-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "network" "WalletNetwork";

-- CreateIndex
CREATE INDEX "ApiKey_network_idx" ON "ApiKey"("network");
