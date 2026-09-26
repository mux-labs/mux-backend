# Verification Scripts Runbook

This runbook documents the fail-closed verification scripts that gate the
custody, wallet-orchestration, and idempotent-user invariants in CI
(`verify-scripts` job) and locally.

## Invariants (summary)

| # | Script | Invariant |
|---|--------|-----------|
| 1 | `verify-encryption.sh` | Wallet private keys are encrypted before database storage and only decrypted inside controlled signing paths |
| 2 | `verify-encryption.sh` | `WALLET_ENCRYPTION_KEY` is environment-driven and validated at boot (≥32 chars, placeholder rejection) |
| 3 | `verify-encryption.sh` | Decryption failures surface stable error codes — never a plaintext fallback |
| 3a | `verify-encryption.sh` | No plaintext key material is **returned, persisted, or logged**; wallet creation emits the AES-256-GCM envelope only |
| 4 | `verify-orchestrator.sh` | Wallet creation is atomic, one-wallet-per-user per network, and idempotent |
| 5 | `verify-orchestrator.sh` | Wallet creation is gated by `FEATURE_WALLET_ORCHESTRATOR` (deny-by-default) and fails closed on dependency outage |
| 6 | `verify-idempotent-user.sh` | `findOrCreateUser` returns the existing user on replay; `authId` is unique in the schema |
| 7 | `verify-idempotent-user.sh` | `POST /users/find-or-create` is authorization-gated and fails closed on dependency outage |

The source of truth for each invariant is the reference document cited in the
script header (e.g. `docs/custody-security-model.md`, `docs/WALLET-API.md`) and
`test/*.e2e-spec.ts`.

## Running locally

Scripts are plain bash + static analysis (no DB / RPC / Horizon). Run from the
repo root:

```bash
bash verify-encryption.sh
bash verify-orchestrator.sh
bash verify-idempotent-user.sh
bash scripts/verify-key-management-consolidation.sh
```

Each script prints `✅ PASS` / `❌ FAIL` per check and a summary with an
exit code (`0` all-pass, `1` any-failure).

## Failure behavior

- A failing check **prints exactly which invariant is violated** and the fix
  reference (doc or test).
- The script exits `1`, which fails the CI `verify-scripts` job.
- Do **not** add `continue-on-error: true` to the CI job — that silently turns a
  fail-closed gate into a log-only check.

## When a check legitimately changes

If a documented invariant evolves:

1. Update the invariant in its source-of-truth document (README / docs / spec)
   first.
2. Update the corresponding `grep`/`find` assertions in the script.
3. Update the runbook and, if relevant, the e2e spec.
4. Land the script and document changes in the same PR.

## Mainnet safety and rollback

- These scripts never submit transactions and never touch mainnet state. They
  only perform static analysis against the working tree.
- The money-path gates they assert (e.g. `FEATURE_WALLET_ORCHESTRATOR`,
  `FEATURE_MAINNET_PAYMENT_SUBMIT`, testnet faucet mainnet gate) are the runtime
  safeguards; a script failure indicates the runtime guard is absent, not that
  the guard has been tripped.
- Rollback strategy: the `verify-scripts` CI job is additive and stateless.
  To roll it out, merge the job and monitor the three checks; to roll back,
  revert the job addition and the scripts in a single PR. No data migration or
  feature-flag flip is required because the job never executes application code.