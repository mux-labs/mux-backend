-- AlterTable
ALTER TABLE "Developer" ADD COLUMN "userId" TEXT;

-- Backfill: link existing developers to the user account that shares the same
-- email address. Only non-deleted users are linked; unmatched developers stay
-- unowned (platform/onboarding accounts) and are untouched by user deletion.
UPDATE "Developer" AS d
SET "userId" = u."id"
FROM "User" AS u
WHERE u."email" = d."email"
  AND u."deletedAt" IS NULL
  AND d."userId" IS NULL;

-- CreateIndex
CREATE INDEX "Developer_userId_idx" ON "Developer"("userId");

-- AddForeignKey
ALTER TABLE "Developer" ADD CONSTRAINT "Developer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
