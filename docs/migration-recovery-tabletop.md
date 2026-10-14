# Migration Recovery Tabletop Exercise

## Purpose

Rehearse [`docs/migration-recovery-runbook.md`](./migration-recovery-runbook.md)
**before** you need it. The runbook is the document an engineer opens at 3am
while a migration is wedged and the API will not start; this exercise is how
we find out that its steps are wrong while nobody is on the line.

This is a **talk-through, not a production drill**. Nobody runs anything
against mainnet, against a real database, or with real key material. The goal
is to walk each recovery path out loud and catch the things that make a
runbook fail in practice: a command that no longer exists, a step whose
precondition nobody checked, a decision point with no named owner.

> **Why this exists:** the runbook referenced five scripts that were not in
> `package.json` (`db:integrity-check`, `test:integration`,
> `prisma:migrate:status`, `prisma:migrate:resolve`,
> `prisma:migrate:deploy`). An operator following it literally would have hit
> "Missing script" with the database in a bad state.
> `test/migration-recovery-tabletop.e2e-spec.ts` now fails closed on that
> class of error, but only a human walkthrough finds the steps that are
> *technically* correct and *operationally* wrong.

## Ground rules (safety)

- **Never** run against mainnet. Use a disposable testnet/staging database.
- **Never** use real key material. Use throwaway values from `.env.example`.
  Real key material exposure is an immediate escalation, not a learning
  opportunity.
- No production database, no real user data, no live credentials in the notes
  or the after-action record.
- The facilitator calls **abort** at any point if the discussion turns into
  actual execution against a real environment.

## Roles

| Role | Responsibility |
| --- | --- |
| **Facilitator** | Reads the inject aloud, keeps time, calls abort. Does not solve. |
| **Participants** | Walk the runbook aloud, narrate every command they would type and why. |
| **Scribe** | Records every command that does not exist, every ambiguous step, and every missing precondition. |

Minimum three people: facilitator, at least two participants, scribe. Run it
at least once per quarter, and after any change to the migration tooling.

## Timebox

**60 minutes total** — 5 min setup, 40 min across the five injects (8 min
each), 15 min after-action. Timeboxing is deliberate: if an inject cannot be
walked through in 8 minutes, the runbook step is too complicated, and that
is the finding.

---

## Inject 1 — Syntax error mid-migration

> *Walk Scenario 1 of the runbook.*

**Premise:** a migration is deployed and fails on a syntax error. The API
will not start.

**Walk through:** detection via `_prisma_migrations`, halting the application
(`kubectl scale`), marking the migration rolled back, fixing the SQL, and
retrying.

**Probe:** what tells you the migration is *safe to mark rolled back* rather
than *already applied*? Is that check present, or assumed?

---

## Inject 2 — Constraint violation on deploy

> *Walk Scenario 2 of the runbook.*

**Premise:** a new UNIQUE constraint fails because of duplicate rows.

**Walk through:** analysing the violation, cleaning/backfilling the data,
rolling back, retrying.

**Probe:** on a large table, who decides the batch size? What is the abort
threshold for "this backfill is taking too long"?

---

## Inject 3 — Lock timeout under live traffic

> *Walk Scenario 3 of the runbook.*

**Premise:** an `ALTER TABLE` blocks behind a long-running query and the
migration times out.

**Walk through:** finding blocking queries, terminating them, setting
`lock_timeout`, retrying.

**Probe:** terminating a backend can roll back a *user's* transaction. Who
authorises that, and what is the customer-facing impact?

---

## Inject 4 — Hung migration, no error in the logs

> *Walk Scenario 4 of the runbook.*

**Premise:** a migration started hours ago, no errors logged, the app is
waiting. This is the scenario that quietly eats an on-call shift.

**Walk through:** checking migration status, identifying the long-running
transaction, terminating it, marking rolled back.

**Probe:** how long do you wait before declaring it hung? If the answer is
"whoever is on call decides", that gap is a finding.

---

## Inject 5 — Migration fails mid key-envelope rotation

> *Walk the "Recovery procedure: failed key-envelope migration" section.*

This inject runs **last** because it is the expensive one: a wedged migration
overlapping a custody-key rotation, with money on the line.

**Premise:** `KEY_DECRYPT_FAILED` or `KEY_VERSION_UNKNOWN` in the logs, and
writes to the money path failing closed.

**Walk through:** halting writes via the kill-switch, verifying envelope
versions, rolling back, re-running behind the flag, re-enabling writes.

**Probe:** the system **fails closed** by design — the API refusing writes is
correct behaviour, not an outage to be routed around. Confirm the team
agrees, and that nobody is tempted to "unblock" it by re-enabling an older
key version. The runbook forbids that because it is how a rotation destroys
the only copy of a key.

---

## Success criteria

The exercise passes when **all** of the following hold:

1. Every command the participants would type exists (verified afterwards by
   `pnpm test:e2e -- test/migration-recovery-tabletop.e2e-spec.ts`).
2. Each runbook scenario has a named owner for every decision point.
3. The team can state, unprompted, that a failing decrypt **must** fail
   closed and that a key-version downgrade is refused by design.
4. The kill-switch (`KEY_MIGRATION_ENABLED`, `KEY_ROTATION_ENABLED`) is
   identified within two minutes of Inject 5 being read.
5. An escalation path is named for suspected key-material exposure.

## Abort conditions

Call **abort** immediately if:

- anyone proposes running a command against mainnet or a real database
- real key material, credentials, or user data appear in the room, in a
  terminal, or in the notes
- the discussion drifts into executing commands for real rather than
  describing them
- anyone proposes bypassing a fail-closed check to restore service

An abort is a successful safety outcome, not a failed exercise.

## After-action record

The scribe produces a written record within 48 hours, filed against the
runbook. It must contain:

- every command that did not exist or behaved differently than documented
- every step with an unstated precondition
- every decision point with no named owner
- the time each inject actually took, versus the 8-minute target
- **any correction needed to the runbook itself** — a runbook that is wrong
  is the primary output of this exercise

Any runbook correction is raised as its own PR, and the contract test must
pass before it merges. Re-run this tabletop after it lands.

## Related documents

- [`docs/migration-recovery-runbook.md`](./migration-recovery-runbook.md) —
  the runbook under exercise
- [`docs/MIGRATION-KEY-MANAGEMENT.md`](./MIGRATION-KEY-MANAGEMENT.md) —
  key-management migration path
- [`docs/custody-security-model.md`](./custody-security-model.md) — custody
  invariants, including what "fail closed" means
- [`SECURITY.md`](../../SECURITY.md) — disclosure and escalation
