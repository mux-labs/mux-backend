-- Migration: add keyVersion field to Wallet
--
-- keyVersion tracks the key algorithm/derivation scheme version on a wallet.
-- It is distinct from:
--   encryptionVersion  – the envelope/KMS format used to encrypt the secret material
--   secretVersion      – a monotonic counter incremented on every key rotation
--
-- Default value of 1 is applied to all existing rows so no data migration is needed.
--
-- Fail-closed invariant: every wallet row MUST carry a non-null keyVersion so
-- that decryption can select the correct key material. A NULL/unknown version
-- must never be treated as "latest" or fall back to plaintext; readers reject
-- rows whose keyVersion is not in the supported set.

ALTER TABLE "Wallet" ADD COLUMN "keyVersion" INTEGER NOT NULL DEFAULT 1;

-- Guard against out-of-range versions being written by older/rogue clients.
-- Supported key versions are >= 1; anything else is rejected at the DB layer
-- so a bad write cannot silently produce an undecryptable wallet.
ALTER TABLE "Wallet"
  ADD CONSTRAINT "Wallet_keyVersion_positive_check" CHECK ("keyVersion" >= 1);

-- Index to support ops queries that scan for wallets on a given key version
-- (e.g. rotation progress, detecting rows stuck on a deprecated version).
CREATE INDEX "Wallet_keyVersion_idx" ON "Wallet" ("keyVersion");
