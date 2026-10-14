-- Migration: webhook dual-secret rotation window (#978)
--
-- Adds `pendingSecret` and `pendingSecretExpiresAt` to WebhookEndpoint so
-- that both the old and new signing secrets are valid during a configurable
-- overlap window.  After the window expires only the new `secret` is accepted.

ALTER TABLE "WebhookEndpoint"
  ADD COLUMN "pendingSecret"          TEXT,
  ADD COLUMN "pendingSecretExpiresAt" TIMESTAMP(3);

-- Index for cheap expiry sweeps
CREATE INDEX "WebhookEndpoint_pendingSecretExpiresAt_idx"
  ON "WebhookEndpoint" ("pendingSecretExpiresAt");
