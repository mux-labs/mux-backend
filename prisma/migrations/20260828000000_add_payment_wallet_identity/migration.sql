ALTER TABLE "Payment" ADD COLUMN "senderWalletId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "receiverWalletId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "transactionId" TEXT;
ALTER TABLE "Payment" ALTER COLUMN "fromId" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "toId" DROP NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "userId" DROP NOT NULL;
CREATE UNIQUE INDEX "Payment_transactionId_key" ON "Payment"("transactionId");