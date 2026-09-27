# Payment Dry-Run

This document describes how to dry-run payment flows against Mux mux-backend
without moving real funds, and how payment idempotency behaves on the write
path.

## Overview

A dry-run executes the same validation, authorization, and idempotency checks
as a live payment, but stops before any irreversible side effect (no ledger
write, no wallet debit, no Horizon submission).

## Dry-run mode

Dry-run is a first-class mode on the payment entrypoint, not a separate code
path. It reuses the exact validation, authz, and idempotency logic of a live
payment and only differs at the final commit step.

### Invariants

1. **No side effects**: a dry-run never writes a payment, never debits a wallet,
   and never submits to Stellar/Horizon. It is safe to call repeatedly.
2. **Same policy as live**: authz (owner/delegate/guardian/API-key/JWT) and
   payload validation are evaluated identically to a live payment. A dry-run
   cannot be used to probe or bypass payment policy.
3. **Deny-by-default**: dry-run is a privileged surface. It is disabled unless
   the caller is authorized and the dry-run feature flag is enabled.
4. **Fail-closed**: if a required dependency (RPC/Horizon/DB) is unavailable,
   the dry-run is rejected rather than returning a misleading success.
5. **No secret leakage**: keys, JWTs, and webhook secrets are never written to
   logs or metrics; only correlation ids and coarse outcomes are emitted.

### Request contract

- Clients request a dry-run by setting `dry_run: true` on the payment request
  (or the equivalent `X-Dry-Run: true` header).
- Dry-run requests MUST still carry a valid `Idempotency-Key`; the same key
  rules apply so that a dry-run cannot be replayed as a live write.
- Missing or malformed keys are rejected with a stable typed error code.

### Response contract

| Outcome | HTTP | Error code | Notes |
| --- | --- | --- | --- |
| Dry-run success | 200 | — | Simulated result; nothing persisted. |
| Dry-run, invalid payload | 400 | `VALIDATION_FAILED` | Same validation as live. |
| Dry-run, unauthorized | 401/403 | `AUTH_*` | Policy not bypassable via dry-run. |
| Dry-run disabled | 403 | `DRY_RUN_DISABLED` | Deny-by-default; flag off. |
| Dependency unavailable | 503 | `DEPENDENCY_UNAVAILABLE` | Fail-closed; safe to retry. |

All responses include a `correlation_id` for tracing. Correlation ids are
opaque and contain no key material.

### Authorization

Dry-run does **not** grant authority. The existing authz model
(owner/delegate/guardian/API-key/JWT) is evaluated first; an unauthorized
principal is rejected even with a valid key. New privileged surfaces are
deny-by-default.

### Observability

Ops-safe metrics are emitted on the dry-run path:

- `payment_dry_run_total` — dry-run requests by outcome.
- `payment_dry_run_denied_total` — dry-run rejected by authz or flag.
- `payment_write_failclosed_total` — write rejected due to dependency outage.

Logs include `correlation_id`, outcome, and coarse reason only. Keys, JWTs, and
webhook secrets are redacted.

## Payment idempotency (exactly-once)

Every payment write path is guarded by an idempotency key so that concurrent or
replayed requests return the original result instead of creating duplicate
payments.

### Invariants

1. **Exactly-once**: for a given `(owner, idempotency_key)` pair, at most one
   payment is ever created. Replays return the stored original result.
2. **Stable identity**: the idempotency key is scoped to the authenticated
   principal (owner/delegate/guardian/API-key/JWT subject). A key issued by one
   principal cannot be replayed by another.
3. **Fail-closed**: if the idempotency store (DB) or a required dependency
   (RPC/Horizon) is unavailable, the write is rejected. We never fall through to
   an unguarded write.
4. **No secret leakage**: keys, JWTs, and webhook secrets are never written to
   logs or metrics; only correlation ids and coarse outcomes are emitted.

### Request contract

- Clients MUST send an idempotency key header (e.g. `Idempotency-Key`) on every
  payment write.
- Missing or malformed keys are rejected with a stable typed error code.
- The key is stored alongside the payment record via the
  `add_payment_idempotency_key` migration.

### Response contract

| Outcome | HTTP | Error code | Notes |
| --- | --- | --- | --- |
| First request, success | 2xx | — | Payment created; key recorded. |
| Replay, same key | 2xx | — | Original result returned verbatim. |
| Replay, conflicting payload | 409 | `IDEMPOTENCY_CONFLICT` | Same key, different body. |
| Missing/invalid key | 400 | `IDEMPOTENCY_KEY_REQUIRED` | Deny-by-default. |
| Dependency unavailable | 503 | `DEPENDENCY_UNAVAILABLE` | Fail-closed; safe to retry. |
| Auth expired / wrong role | 401/403 | `AUTH_*` | Policy not bypassable via key. |

All error responses include a `correlation_id` for tracing. Correlation ids are
opaque and contain no key material.

### Authorization

Idempotency keys do **not** grant authority. The existing authz model
(owner/delegate/guardian/API-key/JWT) is evaluated first; a valid key from an
unauthorized principal is still rejected. New privileged surfaces are
deny-by-default.

### Observability

Ops-safe metrics are emitted on the money path:

- `payment_idempotency_hit_total` — replay served from stored result.
- `payment_idempotency_miss_total` — first-time key observed.
- `payment_idempotency_conflict_total` — same key, different payload.
- `payment_write_failclosed_total` — write rejected due to dependency outage.

Logs include `correlation_id`, outcome, and coarse reason only. Keys, JWTs, and
webhook secrets are redacted.

## Running a dry-run

1. Authenticate with a testnet principal.
2. Send the payment request with `dry_run: true` and a fresh `Idempotency-Key`.
3. Confirm a simulated result is returned and no payment is created.
4. Re-send the identical request; confirm the original result is returned and
   no second payment is created.
5. Re-send with a mutated body under the same key; confirm
   `IDEMPOTENCY_CONFLICT`.
6. Simulate a dependency outage; confirm `DEPENDENCY_UNAVAILABLE` and that no
   payment is written.

## End-to-end proof: auth → wallet → limits → dry-run payment

This section is the canonical E2E proof for the critical path. It is the
contract that `TEST_VERIFICATION_GUIDE.md` and the automated e2e suite assert
against. Each stage is fail-closed: a failure at any stage aborts the run and
no payment is written.

### Stages and invariants

| # | Stage | Invariant | Failure mode |
| --- | --- | --- | --- |
| 1 | **Auth** | A valid principal (owner/delegate/guardian/API-key/JWT) is required. Expired, revoked, or wrong-role principals are rejected before any wallet or limit work. | `AUTH_*` (401/403) |
| 2 | **Wallet** | The resolved wallet belongs to the authenticated principal and is active. A wallet owned by another principal is never used. | `WALLET_NOT_FOUND` / `AUTH_FORBIDDEN` |
| 3 | **Limits** | Per-principal and per-wallet spend limits are evaluated against the requested amount. Over-limit requests are rejected before the dry-run commit. | `LIMIT_EXCEEDED` |
| 4 | **Dry-run payment** | The payment is validated and simulated with the same policy as live, then stopped before any side effect. | `VALIDATION_FAILED` / `DEPENDENCY_UNAVAILABLE` |

### Ordering guarantee

Stages run strictly in order (auth → wallet → limits → dry-run). A later stage
MUST NOT run if an earlier stage fails, so that an unauthorized caller cannot
learn wallet or limit state. This ordering is asserted by the e2e suite.

### Authz negatives (must all be rejected)

- **Owner**: valid owner succeeds; a different owner's wallet is rejected.
- **Delegate**: a valid, non-revoked delegate succeeds; a revoked delegate is
  rejected with `AUTH_FORBIDDEN`.
- **Guardian**: a guardian may act only within its granted scope; out-of-scope
  actions are rejected.
- **API-key**: a valid key succeeds; a revoked or wrong-scope key is rejected.
- **JWT**: a valid, unexpired JWT succeeds; an expired or wrong-role JWT is
  rejected with `AUTH_*`.

A valid idempotency key or dry-run flag never upgrades authority; authz is
always evaluated first.

### Idempotency / replay on the critical path

- The same `(principal, Idempotency-Key)` replayed returns the original result
  and creates no second payment.
- A key issued by one principal cannot be replayed by another principal.
- A dry-run key cannot be replayed as a live write, and vice versa.

### Fail-closed on dependency outage

If RPC, Horizon, or the DB is unavailable at any stage, the run is rejected
with `DEPENDENCY_UNAVAILABLE` (503) and no payment is written. The path never
falls through to an unguarded write.

### Automated coverage

The e2e suite exercises this path end-to-end, including the authz negatives,
idempotency/replay, and dependency-outage cases above. CI keeps this check
required so the critical path cannot regress silently.

## Rollback / kill-switch

Dry-run and idempotency enforcement on the money path are feature-flagged.
Disabling the flags restores the previous behavior; the flags MUST NOT be
disabled on mainnet without a readiness checklist, since doing so re-opens
duplicate-payment risk.

## References

- `TEST_VERIFICATION_GUIDE.md` — how to run the e2e proof above.
- `prisma/migrations/20260724010000_add_payment_idempotency_key/`
- `SECURITY.md` — secret handling and redaction policy.
