-- Migration: add_transaction_export_job
-- Adds the TransactionExportJob table for async transaction export tracking.

CREATE TABLE "TransactionExportJob" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "requestedBy"  TEXT,
    "filters"      JSONB,
    "format"       TEXT NOT NULL DEFAULT 'CSV',
    "status"       TEXT NOT NULL DEFAULT 'PENDING',
    "rowCount"     INTEGER NOT NULL DEFAULT 0,
    "downloadUrl"  TEXT,
    "expiresAt"    TIMESTAMP(3),
    "errorMessage" TEXT,
    "startedAt"    TIMESTAMP(3),
    "completedAt"  TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransactionExportJob_pkey" PRIMARY KEY ("id")
);

-- Indexes for common query patterns
CREATE INDEX "TransactionExportJob_projectId_idx"  ON "TransactionExportJob"("projectId");
CREATE INDEX "TransactionExportJob_status_idx"     ON "TransactionExportJob"("status");
CREATE INDEX "TransactionExportJob_createdAt_idx"  ON "TransactionExportJob"("createdAt");
CREATE INDEX "TransactionExportJob_expiresAt_idx"  ON "TransactionExportJob"("expiresAt");
