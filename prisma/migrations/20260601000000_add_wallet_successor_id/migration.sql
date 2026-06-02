-- AlterTable: add successorId to Wallet for rotation successor linking
ALTER TABLE "Wallet" ADD COLUMN "successorId" TEXT;

-- CreateIndex: unique constraint (one successor per wallet)
CREATE UNIQUE INDEX "Wallet_successorId_key" ON "Wallet"("successorId");

-- CreateIndex: for fast successor lookups
CREATE INDEX "Wallet_successorId_idx" ON "Wallet"("successorId");

-- AddForeignKey: successor self-reference
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_successorId_fkey"
  FOREIGN KEY ("successorId") REFERENCES "Wallet"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
