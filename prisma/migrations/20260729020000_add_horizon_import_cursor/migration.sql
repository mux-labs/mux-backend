-- CreateEnum
CREATE TYPE "HorizonImportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "HorizonImportCursor" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "network" "WalletNetwork" NOT NULL DEFAULT 'TESTNET',
    "resourceType" TEXT NOT NULL,
    "cursor" TEXT,
    "status" "HorizonImportStatus" NOT NULL DEFAULT 'PENDING',
    "recordsImported" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HorizonImportCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HorizonImportCursor_status_idx" ON "HorizonImportCursor"("status");

-- CreateIndex
CREATE UNIQUE INDEX "HorizonImportCursor_accountId_resourceType_network_key" ON "HorizonImportCursor"("accountId", "resourceType", "network");
