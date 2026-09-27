# Feature Flags

# Feature Flags

This document tracks feature flags and kill-switches used across mux-backend.
Every money-path or mainnet-affecting change MUST be gated behind a flag and
have a documented rollback path (see the PR description for the specific
rollback steps).

Related docs:

- `docs/AUTH-FEATURE-FLAGS.md` — authz roles (owner/delegate/guardian/API-key/JWT).
- `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` — mainnet money-path gating.

## Conventions

- Flags are read from environment variables and default to **off** (deny-by-default).
- A flag must be safe to flip at runtime without a redeploy where possible.
- Never log flag values that could contain secrets; log only the flag name and
  the resolved boolean.
- Each flag lists: purpose, default, owner, and rollback behavior.

## Model

Flags are resolved server-side and are the **source of truth**. Clients cannot
enable a privileged surface by sending a flag value; any client-supplied flag is
ignored and the server resolves the effective value from configuration.

Resolution order (first match wins):

1. **Kill-switch** — if a kill-switch is engaged, the surface is disabled
   regardless of any other flag. Kill-switches are deny-by-default and fail
   closed.
2. **Environment default** — per-environment default (testnet vs mainnet).
3. **Explicit override** — operator-set override, audited and logged.

If flag resolution fails (config store outage, malformed value, unknown flag
name), the surface is treated as **disabled** (fail closed).

## Flags

### `SUCCESSOR_MIGRATION_ENABLED`

- **Purpose:** Gate the successor migration tooling (issue #982). When off, the
  successor-migration entrypoints reject all writes with a stable error code
  (`SUCCESSOR_MIGRATION_DISABLED`) and do not touch `wallet.successor_id`.
- **Default:** `false` (off).
- **Owner:** Wallet / AA team.
- **Rollback:** Set to `false` and redeploy/restart. In-flight writes fail closed;
  no partial successor assignments are persisted because the write is a single
  transactional update guarded by the flag check.
- **Notes:** The underlying schema field and migration
  (`prisma/migrations/20260601000000_add_wallet_successor_id/`) are additive and
  safe to leave in place when the flag is off.

### `SUCCESSOR_MIGRATION_MAINNET_ENABLED`

- **Purpose:** Additional kill-switch for mainnet. Even when
  `SUCCESSOR_MIGRATION_ENABLED` is on, mainnet writes require this flag to be on.
- **Default:** `false` (off).
- **Owner:** Wallet / AA team.
- **Rollback:** Set to `false`. Mainnet successor writes fail closed with
  `SUCCESSOR_MIGRATION_MAINNET_DISABLED`; testnet behavior is unaffected.
- **Notes:** Prevents testnet-vs-mainnet misconfiguration from mutating mainnet
  wallet state.

## Wallet orchestrator flags

| Flag | Default (testnet) | Default (mainnet) | Notes |
| --- | --- | --- | --- |
| `wallet.orchestrator.enabled` | `true` | `false` | Master switch for the orchestrator path. |
| `wallet.orchestrator.aa.enabled` | `true` | `false` | Account-abstraction operations. |
| `wallet.orchestrator.payments.enabled` | `true` | `false` | Money-path operations; see mainnet doc. |

Mainnet defaults are `false`; enabling any mainnet money-path flag requires the
readiness checklist in `docs/MAINNET-PAYMENT-FEATURE-FLAG.md`.

## Behavior contract (e2e)

The e2e suite asserts the following invariants:

- **Disabled orchestrator** — requests to orchestrator entrypoints return a
  stable error code (`WALLET_ORCHESTRATOR_DISABLED`) and do not mutate state.
- **Kill-switch precedence** — engaging the kill-switch disables the surface even
  when the environment default is `true`.
- **Fail closed** — a flag-resolution failure yields the disabled behavior, not
  an enabled one.
- **Authz is independent of flags** — a disabled flag denies everyone; an enabled
  flag still enforces owner/delegate/guardian/API-key/JWT policy. Flags never
  grant access.
- **Idempotency** — replayed requests with the same idempotency key return the
  same result and do not double-apply.
- **Correlation ids** — every response carries a correlation id; logs include it
  and never include secrets, raw key material, JWTs, or webhook secrets.

## Error codes

| Code | Meaning |
| --- | --- |
| `WALLET_ORCHESTRATOR_DISABLED` | Orchestrator flag resolved to disabled. |
| `WALLET_ORCHESTRATOR_AA_DISABLED` | AA flag resolved to disabled. |
| `WALLET_ORCHESTRATOR_PAYMENTS_DISABLED` | Payments flag resolved to disabled. |
| `FEATURE_FLAG_RESOLUTION_FAILED` | Flag store unavailable or malformed; fail closed. |

## Observability

- Metrics: flag resolution outcome (enabled/disabled/failed) per flag, and
  denied-request counts per error code.
- Logs: include flag name, resolved value, correlation id, and actor role.
  Redact secrets, keys, JWTs, and webhook secrets.

## Kill-switch checklist

Before enabling any flag above on mainnet:

1. Confirm the readiness checklist in the PR is complete.
2. Confirm authz (owner/delegate/guardian/API-key/JWT) is enforced and covered by
   negative tests.
3. Confirm idempotency/replay protection is active for the write path.
4. Confirm fail-closed behavior on RPC/DB/Horizon outages.
5. Confirm metrics/logs are wired and do not leak secrets or raw key material.

## Rollback

Disabling a flag (or engaging its kill-switch) is the rollback path. Rollback is
safe and immediate; no data migration is required. Document the flag and
kill-switch used in the PR description for any money-path or mainnet-affecting
change.

