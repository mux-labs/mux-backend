-- Hash webhook signing secrets at rest
--
-- Outbound webhook signing secrets were previously stored as plaintext in the
-- `secret` column. They are now derived deterministically from the server-side
-- WEBHOOK_SIGNING_KEY (HMAC-SHA256 over endpoint id + version) and only a
-- SHA-256 hash is persisted, mirroring API key storage.
--
-- NOTE FOR OPERATORS: any endpoint created before this migration held a
-- random plaintext secret that can no longer be re-derived. After deploying,
-- call POST /v1/webhooks/endpoints/:id/rotate-secret for each pre-existing
-- endpoint and share the returned secret with the endpoint owner. New secrets
-- are returned exactly once.

-- 1) Drop the plaintext secret column (existing values are unrecoverable by design).
ALTER TABLE "WebhookEndpoint" DROP COLUMN "secret";

-- 2) Add versioned, hashed secret tracking.
ALTER TABLE "WebhookEndpoint" ADD COLUMN "secretVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "secretHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "WebhookEndpoint" ADD COLUMN "pendingSecretVersion" INTEGER;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "pendingSecretHash" TEXT;
ALTER TABLE "WebhookEndpoint" ADD COLUMN "secretGracePeriodEndsAt" TIMESTAMP(3);
