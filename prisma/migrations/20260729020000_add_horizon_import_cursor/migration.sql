-- Migration: 20260729020000_add_horizon_import_cursor
-- Purpose: Add persistent cursor tracking for Horizon balance import jobs so
--          they can resume from the last successfully-processed ledger after a
--          crash, restart, or dependency outage (issue #975).

CREATE TABLE "HorizonImportCursor" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid(),
  -- Logical stream identifier — e.g. "walletId:<uuid>" or "network:TESTNET"
  "streamKey"   TEXT NOT NULL,
  -- Last Stellar ledger sequence number successfully imported
  "lastLedger"  INTEGER NOT NULL DEFAULT 0,
  -- Paging token returned by Horizon (used by stellar-sdk Cursor pagination)
  "pagingToken" TEXT,
  -- ISO timestamp of when this cursor was last successfully advanced
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- ISO timestamp when the cursor record was created
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HorizonImportCursor_pkey" PRIMARY KEY ("id")
);

-- Each stream has exactly one cursor row
CREATE UNIQUE INDEX "HorizonImportCursor_streamKey_key" ON "HorizonImportCursor"("streamKey");

-- Fast lookup by stream key
CREATE INDEX "HorizonImportCursor_streamKey_idx" ON "HorizonImportCursor"("streamKey");

-- Allow monitoring queries to find stale cursors
CREATE INDEX "HorizonImportCursor_updatedAt_idx" ON "HorizonImportCursor"("updatedAt");
