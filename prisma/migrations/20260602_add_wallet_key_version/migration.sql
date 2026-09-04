-- Migration: add keyVersion field to Wallet
--
-- keyVersion tracks the key algorithm/derivation scheme version on a wallet.
-- It is distinct from:
--   encryptionVersion  – the envelope/KMS format used to encrypt the secret material
--   secretVersion      – a monotonic counter incremented on every key rotation
--
-- Default value of 1 is applied to all existing rows so no data migration is needed.

ALTER TABLE "Wallet" ADD COLUMN "keyVersion" INTEGER NOT NULL DEFAULT 1;
