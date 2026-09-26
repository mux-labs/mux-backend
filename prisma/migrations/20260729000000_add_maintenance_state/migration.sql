-- Persist the global maintenance switch so all application instances agree.
CREATE TABLE "MaintenanceState" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "retryAfterSeconds" INTEGER,
    "enabledAt" TIMESTAMP(3),
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceState_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so reads never have to handle a missing state and
-- toggles are idempotent upserts against a stable primary key.
INSERT INTO "MaintenanceState" ("id", "enabled", "updatedAt")
VALUES ('global', false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Deny-by-default: only the singleton 'global' row is a valid maintenance state.
ALTER TABLE "MaintenanceState"
    ADD CONSTRAINT "MaintenanceState_singleton_check" CHECK ("id" = 'global');

-- Guard against nonsensical retry hints leaking to clients.
ALTER TABLE "MaintenanceState"
    ADD CONSTRAINT "MaintenanceState_retry_after_check"
    CHECK ("retryAfterSeconds" IS NULL OR "retryAfterSeconds" >= 0);

-- Keep enabledAt consistent with the enabled flag so fail-closed checks and
-- audit logs can rely on it.
ALTER TABLE "MaintenanceState"
    ADD CONSTRAINT "MaintenanceState_enabled_at_check"
    CHECK (("enabled" = false AND "enabledAt" IS NULL) OR ("enabled" = true AND "enabledAt" IS NOT NULL));
