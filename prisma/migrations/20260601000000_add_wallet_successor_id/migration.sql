-- AlterTable: add successorId to Wallet for rotation successor linking
ALTER TABLE "Wallet" ADD COLUMN "successorId" TEXT;

-- CreateIndex: unique constraint (one successor per wallet)
CREATE UNIQUE INDEX "Wallet_successorId_key" ON "Wallet"("successorId");

-- CreateIndex: for fast successor lookups
CREATE INDEX "Wallet_successorId_idx" ON "Wallet"("successorId");

-- AddForeignKey: successor self-reference
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_successorId_fkey"
  FOREIGN KEY ("successorId") REFERENCES "Wallet"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Invariant: a wallet cannot be its own successor (no self-reference).
-- Enforced at the DB layer so no code path can bypass it.
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_successorId_not_self"
  CHECK ("successorId" IS NULL OR "successorId" <> "id");

-- Invariant: successor must exist and be owned/authorized.
-- The FK above guarantees existence; ownership/authorization is enforced in the
-- wallet service layer (deny-by-default) since it depends on runtime policy.
--
-- Invariant: single active successor per wallet is guaranteed by the unique
-- index on "successorId" (a wallet can be the successor of at most one wallet).
--
-- Invariant: no cycles (A -> B -> A). Cycles cannot be expressed as a simple
-- CHECK constraint; they are rejected in the wallet service layer on write and
-- covered by unit tests. The FK ON DELETE SET NULL keeps the graph consistent
-- when a successor is removed.
