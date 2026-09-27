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

-- Invariant: successor must be a distinct, existing wallet and the link must be
-- acyclic. Enforced at the DB layer via a recursive trigger so that no code path
-- (including raw SQL or future services) can bypass the successor-migration
-- policy. Fail-closed: any violation raises and aborts the transaction.
CREATE OR REPLACE FUNCTION "Wallet_successorId_no_cycle"()
RETURNS TRIGGER AS $$
DECLARE
  cursor_id TEXT;
  hops INT := 0;
BEGIN
  -- NULL successor clears the link; nothing to validate.
  IF NEW."successorId" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Self-reference guard (defense in depth alongside the CHECK constraint).
  IF NEW."successorId" = NEW."id" THEN
    RAISE EXCEPTION 'wallet_successor_self_reference'
      USING ERRCODE = '23514';
  END IF;

  -- Walk the successor chain from the proposed successor. If we ever reach the
  -- wallet being updated, the new link would create a cycle (A -> B -> ... -> A).
  cursor_id := NEW."successorId";
  WHILE cursor_id IS NOT NULL LOOP
    hops := hops + 1;
    IF hops > 1000 THEN
      RAISE EXCEPTION 'wallet_successor_cycle_depth_exceeded'
        USING ERRCODE = '23514';
    END IF;

    IF cursor_id = NEW."id" THEN
      RAISE EXCEPTION 'wallet_successor_cycle_detected'
        USING ERRCODE = '23514';
    END IF;

    SELECT "successorId" INTO cursor_id FROM "Wallet" WHERE "id" = cursor_id;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Wallet_successorId_no_cycle_trg"
  BEFORE INSERT OR UPDATE OF "successorId" ON "Wallet"
  FOR EACH ROW
  EXECUTE FUNCTION "Wallet_successorId_no_cycle"();
