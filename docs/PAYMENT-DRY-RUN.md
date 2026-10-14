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
   Enforced by `PaymentMoneyPathService.execute` in
   `src/payments/payment-money-path.service.ts`: the submission port
   (`PAYMENT_SUBMISSION_PORT`) is never referenced on the dry-run path, so a
   dry-run cannot reach Horizon even when every money-path flag is on. Covered
   by `src/payments/payment-money-path.service.spec.ts`.
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

- Clients request a dry-run on `POST /v1/payments` by setting `dry_run: true`
  in the body, or the equivalent `X-Dry-Run: true` header
  (`src/payments/payments.controller.ts`). Both spellings are honoured and
  neither can be turned off once requested.
- Dry-run requests MUST still carry a valid `Idempotency-Key`; the same key
  rules apply so that a dry-run cannot be replayed as a live write.
- Keys are scoped to the authenticated principal and the key is **reserved
  before** any submission, so two concurrent requests can never both submit and
  a replay returns the original result. The key is stored hashed, and the
  request body is stored as a sha256 fingerprint.
- Missing or malformed keys are rejected with a stable typed error code.

### Error codes

Codes are stable and live in the shared envelope
(`src/common/dto/error-envelope.dto.ts`).

| Code | HTTP | Meaning |
| --- | --- | --- |
| `DRY_RUN_DISABLED` | 403 | Alias documented below; the emitted code is `PAYMENT_DRY_RUN_DISABLED`. |
| `PAYMENT_DRY_RUN_DISABLED` | 403 | `PAYMENT_DRY_RUN_ENABLED` is off (deny-by-default). |
| `PAYMENT_KILL_SWITCH_ENGAGED` | 403 | `PAYMENT_KILL_SWITCH=true`; no writes at all. |
| `VALIDATION_FAILED` | 400 | Same validation as a live payment. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Missing or malformed idempotency key. |
| `IDEMPOTENCY_CONFLICT` | 409 | Same key, different payload, or key still in flight. |
| `DEPENDENCY_UNAVAILABLE` | 503 | The idempotency store or RPC/Horizon is down; fail-closed. |

### Response contract

| Outcome | HTTP | Error code | Notes |
| --- | --- | --- | --- |
| Dry-run success | 200 | — | Simulated result; nothing persisted. |
| Dry-run, invalid payload | 400 | `VALIDATION_FAILED` | Same validation as live. |
| Dry-run, unauthorized | 401/403 | `AUTH_*` | Policy not bypassable via dry-run. |
| Dry-run disabled | 403 | `PAYMENT_DRY_RUN_DISABLED` | Deny-by-default; `PAYMENT_DRY_RUN_ENABLED` off. |
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

- `payments_dry_run_total` — dry-run requests that were simulated.
- `payment_dry_run_denied_total` — dry-run rejected because the flag is off.
- `payments_rejected_total` — every refusal on the money path.
- `payment_idempotency_hit_total` / `payment_idempotency_miss_total` /
  `payment_idempotency_conflict_total` — idempotency outcomes.
- `payment_write_failclosed_total` — write rejected due to dependency outage.
- `payment_idempotency_store_write_failed_total` — a payment was submitted but
  its idempotency record could not be written (reconcile, never retry blindly).

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

## Rollback / kill-switch

Dry-run and idempotency enforcement on the money path are feature-flagged.
Disabling the flags restores the previous behavior; the flags MUST NOT be
disabled on mainnet without a readiness checklist, since doing so re-opens
duplicate-payment risk.

## References

- `src/payments/payment-money-path.service.ts` — the gate that enforces every
  invariant above.
- `src/payments/payment-money-path.policy.ts` — flag resolution (deny-by-default).
- `src/payments/prisma-payment-idempotency.store.ts` — reserve/complete/release.
- `prisma/migrations/20260724010000_add_payment_idempotency_key/`
- `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` — the flag table and kill-switch.
- `SECURITY.md` — secret handling and redaction policy.
