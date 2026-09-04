-- Migration: add assetCode field to Payment
--
-- assetCode is an optional field that stores ISO 4217 currency code or custom asset identifier.
-- Used to validate and track which asset is being transferred in a payment.

ALTER TABLE "Payment" ADD COLUMN "assetCode" TEXT;
