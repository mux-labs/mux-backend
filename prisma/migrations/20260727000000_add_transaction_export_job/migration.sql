-- Migration: add_transaction_export_job
-- Adds the TransactionExportJob table for async transaction export tracking.
-- Secure downloads: exports are scoped to a project, requested by an
-- authenticated principal, and only downloadable via a single-use token that
-- expires. Fail-closed: a job is never downloadable unless it COMPLETED and
-- its token has not expired or been revoked.

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

    -- Secure download fields
    "downloadTokenHash" TEXT,
    "downloadTokenUsedAt" TIMESTAMP(3),
    "downloadCount"     INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey"    TEXT,
    "correlationId"     TEXT,

    CONSTRAINT "TransactionExportJob_pkey" PRIMARY KEY ("id")
);

-- Indexes for common query patterns
CREATE INDEX "TransactionExportJob_projectId_idx"  ON "TransactionExportJob"("projectId");
CREATE INDEX "TransactionExportJob_status_idx"     ON "TransactionExportJob"("status");
CREATE INDEX "TransactionExportJob_createdAt_idx"  ON "TransactionExportJob"("createdAt");
CREATE INDEX "TransactionExportJob_expiresAt_idx"  ON "TransactionExportJob"("expiresAt");

-- Idempotency: a given (projectId, idempotencyKey) maps to at most one job so
-- concurrent/replayed export requests cannot create duplicate jobs.
CREATE UNIQUE INDEX "TransactionExportJob_projectId_idempotencyKey_key"
    ON "TransactionExportJob"("projectId", "idempotencyKey")
    WHERE "idempotencyKey" IS NOT NULL;

-- Secure download lookup by token hash (single-use, expiring).
CREATE INDEX "TransactionExportJob_downloadTokenHash_idx"
    ON "TransactionExportJob"("downloadTokenHash");

-- Fail-closed status guard: only known lifecycle states are permitted.
ALTER TABLE "TransactionExportJob"
    ADD CONSTRAINT "TransactionExportJob_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED', 'REVOKED'));

-- A job may only expose a download URL once it has completed successfully.
ALTER TABLE "TransactionExportJob"
    ADD CONSTRAINT "TransactionExportJob_download_requires_completed"
    CHECK ("downloadUrl" IS NULL OR "status" = 'COMPLETED');
