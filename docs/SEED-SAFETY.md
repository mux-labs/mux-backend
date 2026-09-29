# Demo Seed Safety (#928)

`pnpm prisma:seed` writes **demo** users, wallets, and transactions using
deterministic placeholder values. It is a local development convenience and is
now gated so it cannot be run by accident against a database that matters.

The gate lives in [`src/common/seed/seed-safety.ts`](../src/common/seed/seed-safety.ts)
and is asserted by
[`src/common/seed/seed-safety.spec.ts`](../src/common/seed/seed-safety.spec.ts).

---

## Why the gate exists

The seed creates rows that *look* real but are not:

- Wallet public keys are padded fake `G` addresses that are not valid Stellar
  accounts.
- `encryptedSecret` is the literal string `encrypted-demo-secret-<authId>`, not
  an actual ciphertext. Such a wallet reports `ACTIVE` and can never sign.
- Transactions carry fabricated amounts, memos, and ledger numbers.

Pointed at a shared or production database, the seed would overwrite
`lastLoginAt` on real users, mint unusable `ACTIVE` wallets, and inject fake
money movement into transaction history.

---

## Invariants

1. **Production is never seeded.** `NODE_ENV=production` blocks the seed with
   `SEED_BLOCKED_PRODUCTION`. There is **no** override.
2. **Mainnet is never seeded.** `STELLAR_NETWORK=PUBLIC`/`MAINNET` blocks the
   seed with `SEED_BLOCKED_MAINNET`. There is **no** override.
3. **Non-local databases are blocked by default.** A `DATABASE_URL` whose host
   is not local is refused with `SEED_BLOCKED_NON_LOCAL_DATABASE` unless
   `PRISMA_SEED_ALLOW_NON_LOCAL=true`.
4. **Unparseable is treated as unsafe.** A missing or unparseable
   `DATABASE_URL` is refused with `SEED_BLOCKED_DATABASE_URL` — the seed never
   assumes "probably local".
5. **A flag typo is an error, not a default.** An unrecognized value for a
   `PRISMA_SEED_*` flag is refused with `SEED_BLOCKED_INVALID_FLAG` rather than
   being read as either true or false. Every refusal — including a typo — is
   reported through the same stable `code`, so the operator always gets an
   actionable message.
6. **A typo cannot mask a worse refusal.** The non-overridable blocks
   (`NODE_ENV=production`, mainnet `STELLAR_NETWORK`) are evaluated *before* the
   flags are parsed, so a malformed flag never hides the production or mainnet
   refusal — those keep their own codes regardless.
7. **Mainnet demo wallets are opt-in.** The `MAINNET` wallet rows are only
   created with `PRISMA_SEED_INCLUDE_MAINNET=true`; the default is off.
8. **No credentials in output.** A refusal reports the stable code, the
   remediation, and the database *host* only — never the password.

---

## Environment variables

| Variable                         | Default | Effect                                                        |
|----------------------------------|---------|---------------------------------------------------------------|
| `PRISMA_SEED_ALLOW_NON_LOCAL`    | `false` | Permit seeding a non-local (throwaway) database               |
| `PRISMA_SEED_INCLUDE_MAINNET`    | `false` | Also create the demo `MAINNET` wallet rows                    |

There is deliberately no variable to un-block production or mainnet.

---

## Local usage

```bash
# Typical: docker compose Postgres, or a local install
pnpm prisma:migrate
pnpm prisma:seed
```

To seed a throwaway **shared** database (e.g. a scratch box you are about to
delete), opt in explicitly and expect a warning in the output:

```bash
PRISMA_SEED_ALLOW_NON_LOCAL=true pnpm prisma:seed
```

To also create mainnet-shaped demo rows for UI work:

```bash
PRISMA_SEED_INCLUDE_MAINNET=true pnpm prisma:seed
```

---

## Failure modes

| Situation                                        | Result                                              | Operator action                                     |
|--------------------------------------------------|-----------------------------------------------------|------------------------------------------------------|
| `NODE_ENV=production`                            | Exit 1, `SEED_BLOCKED_PRODUCTION`                   | Run against a local database                         |
| `STELLAR_NETWORK=PUBLIC`                          | Exit 1, `SEED_BLOCKED_MAINNET`                      | Use `TESTNET`; the seed has no mainnet mode          |
| `DATABASE_URL` points at a shared host           | Exit 1, `SEED_BLOCKED_NON_LOCAL_DATABASE`           | Set `PRISMA_SEED_ALLOW_NON_LOCAL=true` if throwaway  |
| `DATABASE_URL` missing                           | Exit 1, `SEED_BLOCKED_DATABASE_URL`                 | Provide a local connection string                    |
| `PRISMA_SEED_ALLOW_NON_LOCAL=treu`                | Exit 1, `SEED_BLOCKED_INVALID_FLAG`                 | Fix the boolean                                     |
| Seed already ran once                             | Safe: every write is an `upsert` keyed on the demo auth id | Re-running is idempotent                       |

---

## Rollback

The gate is code, not configuration. To restore the old permissive behavior
during local debugging, point `DATABASE_URL` at localhost (or set
`PRISMA_SEED_ALLOW_NON_LOCAL=true`) — the production and mainnet blocks remain
in force unconditionally. There is no runtime flag that disables it.
