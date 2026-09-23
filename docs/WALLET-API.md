# Wallet API — Payment Wallet Identity Linkage

This document specifies the payment wallet identity linkage contract for Mux
Protocol. It is the source of truth for how a payment wallet is bound to an
owning identity, how authorization is enforced, and how writes behave under
failure. It aligns with the migration
`prisma/migrations/20260828000000_add_payment_wallet_identity/`.

Related docs:

- `docs/custody-security-model.md` — custody and key-handling invariants.
- `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` — mainnet kill-switch and rollout.

## Invariants

1. **Server is source of truth.** The backend (and Soroban contracts) own the
   authoritative mapping between a payment wallet and its owning identity.
   Clients never assert ownership; they request it and the server decides.
2. **Deny by default.** Every privileged surface introduced by payment wallet
   identity linkage requires an explicit authorization decision. Absence of a
   valid role, delegate, guardian, API key, or JWT is a denial, not a default
   allow.
3. **Fail closed on writes.** If the database, RPC, or Horizon is unavailable,
   write operations (link, unlink, delegate grant/revoke) fail with a stable
   error and no partial state. Reads may degrade; writes may not.
4. **Idempotent by identity.** Link and unlink operations are idempotent on
   `(identityId, walletAddress, chain)`. Replays and concurrent duplicates
   converge to the same terminal state and never create duplicate rows.
5. **No secret leakage.** Responses, logs, and metrics never contain raw key
   material, JWTs, webhook secrets, or full signed payloads.

## Data model

The migration `20260828000000_add_payment_wallet_identity` introduces the
linkage record. Conceptually:

| Field          | Type     | Notes                                              |
| -------------- | -------- | -------------------------------------------------- |
| `id`           | uuid     | Primary key.                                       |
| `identityId`   | uuid     | Owning identity (developer user / account).        |
| `walletAddress`| string   | Stellar/Soroban address.                           |
| `chain`        | string   | Chain discriminator (e.g. `stellar`).              |
| `status`       | enum     | `pending` \| `active` \| `revoked`.                |
| `createdAt`    | datetime | Creation timestamp.                                |
| `updatedAt`    | datetime | Last mutation timestamp.                           |

Uniqueness is enforced on `(identityId, walletAddress, chain)` so that
concurrent link requests cannot create duplicates.

## Authorization model

Payment wallet identity operations are authorized against the following roles.
All checks are deny-by-default.

| Role       | Can link | Can unlink | Can grant delegate | Can revoke delegate |
| ---------- | -------- | ---------- | ------------------ | ------------------- |
| `owner`    | yes      | yes        | yes                | yes                 |
| `delegate` | no       | no         | no                 | no                  |
| `guardian` | no       | yes        | no                 | yes                 |
| API key    | per scope| per scope  | no                 | no                  |
| JWT        | per role | per role   | per role           | per role            |

Rules:

- A **delegate** may operate on a wallet only within the scope granted by the
  owner. Delegates cannot link or unlink wallets or manage other delegates.
- A **guardian** may unlink or revoke a delegate for recovery, but cannot link
  new wallets or grant delegates.
- **Expired auth** (JWT or API key) is rejected before any state is read.
- **Revoked delegates** are rejected even if their token has not yet expired.
- **Wrong role** is rejected with `403` and a stable error code.

## Endpoints

All endpoints require authentication. All responses include a `correlationId`
for tracing. Errors use the stable codes below.

### `POST /v1/payment-wallets`

Link a payment wallet to an identity.

Request:

```json
{
  "identityId": "uuid",
  "walletAddress": "G...",
  "chain": "stellar"
}
```

Behavior:

- Requires `owner` role.
- Idempotent on `(identityId, walletAddress, chain)`. A replay returns the
  existing linkage with `200`; a new linkage returns `201`.
- Fails closed if the database is unavailable.

### `DELETE /v1/payment-wallets/:id`

Unlink a payment wallet.

Behavior:

- Requires `owner` or `guardian` role.
- Idempotent: unlinking an already-revoked linkage returns `200`.
- Fails closed if the database is unavailable.

### `POST /v1/payment-wallets/:id/delegates`

Grant a delegate.

Behavior:

- Requires `owner` role.
- Rejects revoked or expired caller auth.

### `DELETE /v1/payment-wallets/:id/delegates/:delegateId`

Revoke a delegate.

Behavior:

- Requires `owner` or `guardian` role.
- Revocation takes effect immediately; subsequent delegate requests are denied.

## Error codes

| Code                          | HTTP | Meaning                                          |
| ----------------------------- | ---- | ------------------------------------------------ |
| `WALLET_IDENTITY_INVALID`     | 400  | Malformed identity or wallet address.            |
| `WALLET_IDENTITY_UNAUTHORIZED`| 401  | Missing or expired auth.                         |
| `WALLET_IDENTITY_FORBIDDEN`   | 403  | Wrong role or revoked delegate.                  |
| `WALLET_IDENTITY_CONFLICT`    | 409  | Linkage exists with conflicting state.           |
| `WALLET_IDENTITY_UNAVAILABLE` | 503  | Dependency (DB/RPC/Horizon) unavailable.         |
| `WALLET_IDENTITY_RATE_LIMITED`| 429  | Rate limit exceeded.                             |

All error responses include `correlationId` and never include secrets or raw
key material.

## Idempotency and concurrency

- Link and unlink are idempotent on the natural key. Concurrent duplicates are
  resolved by the unique constraint; the loser returns the winner's state.
- Clients SHOULD send an `Idempotency-Key` header on writes. The server stores
  the key with the resulting state and replays the stored response for repeats.
- Replayed requests with a different body for the same key are rejected with
  `WALLET_IDENTITY_CONFLICT`.

## Failure modes

| Failure                     | Behavior                                              |
| --------------------------- | ----------------------------------------------------- |
| DB outage                   | Writes fail `503 WALLET_IDENTITY_UNAVAILABLE`.        |
| RPC/Horizon outage          | Writes fail closed; no partial linkage.               |
| Auth expiry                 | `401 WALLET_IDENTITY_UNAUTHORIZED`.                   |
| Wrong role / revoked delegate| `403 WALLET_IDENTITY_FORBIDDEN`.                     |
| Oversized batch             | Rejected `400`; batch size capped.                    |
| Spoofed webhook             | Rejected; signature verified before processing.       |
| Testnet vs mainnet misconfig| Rejected; chain and network must match configuration. |

## Observability

- Every request emits a structured log line with `correlationId`, `identityId`,
  `walletAddress` (redacted to a prefix), `role`, `outcome`, and `latencyMs`.
- Metrics: `wallet_identity_link_total{outcome}`, `wallet_identity_unlink_total{outcome}`,
  `wallet_identity_authz_denied_total{reason}`, and
  `wallet_identity_dependency_error_total{dependency}`.
- No metric label or log field contains secrets, JWTs, or raw key material.

## Mainnet safety

Payment wallet identity linkage is gated by the mainnet payment feature flag
described in `docs/MAINNET-PAYMENT-FEATURE-FLAG.md`. When the flag is off, all
linkage writes return `503 WALLET_IDENTITY_UNAVAILABLE` and no state changes.
Rollback is performed by disabling the flag; no data migration is required.

## Contributor checklist (Stellar Wave)

- [ ] Read this document and the custody security model before changing
      linkage code.
- [ ] Add unit tests for invariants and auth negatives.
- [ ] Add integration/e2e coverage on the critical path.
- [ ] Keep CI green for the package.
- [ ] Document any new error code or metric.
