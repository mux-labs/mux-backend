-- Migration: add nickname field to Wallet
--
-- nickname is a short, user-defined label for a wallet (e.g. "Savings", "Hot wallet").
-- It is optional, mutable, and stored as plain text.
-- Max length is enforced in the application layer (100 characters).

ALTER TABLE "Wallet" ADD COLUMN "nickname" TEXT;
