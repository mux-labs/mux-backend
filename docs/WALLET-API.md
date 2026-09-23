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

## Payment asset code

The migration `20260723_add_asset_code_to_payment` adds an `assetCode` column to
the `Payment` model. It is the canonical, server-validated identifier of the
asset a payment settles in, and it is the source of truth for AA/wallet/payment
behavior. Clients never choose an unvalidated asset code.

| Field       | Type   | Notes                                                       |
| ----------- | ------ | ----------------------------------------------------------- |
| `assetCode` | string | Non-null. Defaults to `XLM` for legacy rows.                |

Rules:

- `assetCode` is **non-null** with a default of `XLM`, so existing rows and
  legacy clients keep working without a backfill race.
- Allowed values are the configured asset allowlist (native `XLM` plus issued
  asset codes). Anything outside the allowlist is rejected with
  `PAYMENT_ASSET_CODE_INVALID`.
- Length is capped at 12 characters and the charset is restricted to
  `A-Z0-9` (Stellar asset code rules). Codes are normalized to upper case
  before validation and persistence.
- `assetCode` is immutable after creation. Changing the asset of an existing
  payment requires a new payment; attempts to mutate it are rejected with
  `PAYMENT_ASSET_CODE_IMMUTABLE`.
- The server remains the source of truth: a client-supplied `assetCode` is
  validated against the allowlist and never trusted to select a spend target.

### Asset code error codes

| Code                            | HTTP | Meaning                                        |
| ------------------------------- | ---- | ---------------------------------------------- |
| `PAYMENT_ASSET_CODE_INVALID`    | 400  | Missing, malformed, or non-allowlisted code.   |
| `PAYMENT_ASSET_CODE_IMMUTABLE`  | 409  | Attempt to change `assetCode` after creation.  |
| `PAYMENT_ASSET_CODE_UNAVAILABLE`| 503  | Asset metadata dependency unavailable.         |

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
- Payment create/read entrypoints that carry `assetCode` require the same
  owner/delegate/guardian/API-key/JWT authorization as the underlying payment;
  `assetCode` never widens a caller's privileges.

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

### `POST /v1/payments`

Create a payment. The request accepts an optional `assetCode`; when omitted it
resolves to the configured default (`XLM`).

Request:

```json
{
  "identityId": "uuid",
  "walletAddress": "G...",
  "chain": "stellar",
  "assetCode": "XLM",
  "amount": "1000000"
}
```

Behavior:

- Requires the same authorization as the underlying payment (owner, scoped
  delegate, guardian for recovery, or a scoped API key / JWT).
- `assetCode` is normalized to upper case, validated against the allowlist, and
  persisted. Invalid codes return `400 PAYMENT_ASSET_CODE_INVALID`.
- Idempotent on the client `Idempotency-Key`; a replay returns the stored
  payment including its `assetCode`.
- Fails closed if the database, RPC, or Horizon is unavailable.

### `GET /v1/payments/:id`

Read a payment. The response always includes `assetCode`.

Behavior:

- Requires the same authorization as the underlying payment.
- Returns the persisted `assetCode`; never recomputes it from client input.

## Error codes

| Code                          | HTTP | Meaning                                          |
| ----------------------------- | ---- | ------------------------------------------------ |
| `WALLET_IDENTITY_INVALID`     | 400  | Malformed identity or wallet address.            |
| `WALLET_IDENTITY_UNAUTHORIZED`| 401  | Missing or expired auth.                         |
| `WALLET_IDENTITY_FORBIDDEN`   | 403  | Wrong role or revoked delegate.                  |
| `WALLET_IDENTITY_CONFLICT`    | 409  | Linkage exists with conflicting state.           |
| `WALLET_IDENTITY_UNAVAILABLE` | 503  | Dependency (DB/RPC/Horizon) unavailable.         |
| `WALLET_IDENTITY_RATE_LIMITED`| 429  | Rate limit exceeded.                             |
| `PAYMENT_ASSET_CODE_INVALID`  | 400  | Missing, malformed, or non-allowlisted code.     |
| `PAYMENT_ASSET_CODE_IMMUTABLE`| 409  | Attempt to change `assetCode` after creation.    |
| `PAYMENT_ASSET_CODE_UNAVAILABLE`| 503 | Asset metadata dependency unavailable.          |

All error responses include `correlationId` and never include secrets or raw
key material.

## Idempotency and concurrency

- Link and unlink are idempotent on the natural key. Concurrent duplicates are
  resolved by the unique constraint; the loser returns the winner's state.
- Payment creation is idempotent on the client `Idempotency-Key`; the stored
  response includes the resolved `assetCode`.
- Clients SHOULD send an `Idempotency-Key` header on writes. The server stores
  the key with the resulting state and replays the stored response for repeats.
- Replayed requests with a different body for the same key are rejected with
  `WALLET_IDENTITY_CONFLICT`.

## Failure modes

| Failure                     | Behavior                                              |
| --------------------------- | ----------------------------------------------------- |
| DB outage                   | Writes fail `503 WALLET_IDENTITY_UNAVAILABLE`.        |
| RPC/Horizon outage          | Writes fail closed; no partial linkage.               |
| Asset metadata outage       | Writes fail `503 PAYMENT_ASSET_CODE_UNAVAILABLE`.     |
| Auth expiry                 | `401 WALLET_IDENTITY_UNAUTHORIZED`.                   |
| Wrong role / revoked delegate| `403 WALLET_IDENTITY_FORBIDDEN`.                     |
| Oversized batch             | Rejected `400`; batch size capped.                    |
| Spoofed webhook             | Rejected; signature verified before processing.       |
| Testnet vs mainnet misconfig| Rejected; chain and network must match configuration. |

## Observability

- Every request emits a structured log line with `correlationId`, `identityId`,
  `walletAddress` (redacted to a prefix), `role`, `outcome`, and `latencyMs`.
- Payment writes additionally log the resolved `assetCode` (never key material).
- Metrics: `wallet_identity_link_total{outcome}`, `wallet_identity_unlink_total{outcome}`,
  `wallet_identity_authz_denied_total{reason}`,
  `wallet_identity_dependency_error_total{dependency}`, and
  `payment_asset_code_total{assetCode,outcome}`.
- No metric label or log field contains secrets, JWTs, or raw key material.

## Mainnet safety

Payment wallet identity linkage is gated by the mainnet payment feature flag
described in `docs/MAINNET-PAYMENT-FEATURE-FLAG.md`. When the flag is off, all
linkage writes return `503 WALLET_IDENTITY_UNAVAILABLE` and no state changes.
Rollback is performed by disabling the flag; no data migration is required.

Asset code validation is part of the same money path and is gated by the same
flag. When the flag is off, payment writes that carry `assetCode` fail closed
with `503 PAYMENT_ASSET_CODE_UNAVAILABLE` and no state changes. Rollback is the
flag flip; the `assetCode` column is additive and requires no data migration.

## Contributor checklist (Stellar Wave)

- [ ] Read this document and the custody security model before changing
      linkage or asset code code.
- [ ] Add unit tests for invariants and auth negatives, including asset code
      allowlist and immutability cases.
- [ ] Add integration/e2e coverage on the payment critical path.
- [ ] Keep CI green for this package; add a required check if ungated.
- [ ] Update runbooks and cross-links when behavior changes.
