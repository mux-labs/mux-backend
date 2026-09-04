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
