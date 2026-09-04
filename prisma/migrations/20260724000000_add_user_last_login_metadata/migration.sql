-- Migration: add lastLoginIp and lastLoginUserAgent to User
--
-- Captures the IP address and User-Agent seen on the user's most recent
-- successful authentication, alongside the existing lastLoginAt timestamp.
-- Both columns are nullable so existing rows require no backfill.

ALTER TABLE "User" ADD COLUMN "lastLoginIp" TEXT;
ALTER TABLE "User" ADD COLUMN "lastLoginUserAgent" TEXT;
