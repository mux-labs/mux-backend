-- Migration: add assetCode field to Payment
--
-- assetCode is an optional field that stores ISO 4217 currency code or custom asset identifier.
-- Used to validate and track which asset is being transferred in a payment.
--
-- Invariants (issue #896):
--   * assetCode is nullable for backward compatibility with pre-existing rows.
--   * When present, assetCode must be 1..12 characters, uppercase A-Z0-9 only
--     (ISO 4217 fiat codes and Stellar asset codes both fit this charset).
--   * The application layer is the source of truth for the allowed asset
--     allowlist; the DB constraint is a fail-closed backstop so no writer can
--     persist an out-of-policy asset code.

ALTER TABLE "Payment" ADD COLUMN "assetCode" TEXT;

-- Fail-closed backstop: reject malformed asset codes at the storage layer.
-- NULL is allowed (legacy rows / asset-agnostic payments).
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_assetCode_format_check"
  CHECK (
    "assetCode" IS NULL
    OR (
      char_length("assetCode") BETWEEN 1 AND 12
      AND "assetCode" ~ '^[A-Z0-9]+$'
    )
  );

-- Lookup path for asset-scoped payment queries and reconciliation.
CREATE INDEX "Payment_assetCode_idx" ON "Payment" ("assetCode");
