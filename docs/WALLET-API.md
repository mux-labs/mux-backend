# Wallet API — Payment Wallet Identity Linkage

This document specifies the payment wallet identity linkage contract for Mux
Protocol. It is the source of truth for how a payment wallet is bound to an
owning identity, how authorization is enforced, and how writes behave under
failure. It aligns with the migration
`prisma/migrations/20260828000000_add_payment_wallet_identity/`.

Related docs:

- `docs/custody-security-model.md` — custody and key-handling invariants.
- `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` — mainnet kill-switch and rollout.
- `README.md` — fee sponsorship budgets API reference (#920).

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
- **Wallet creation is retry-safe.** `POST /v1/wallets/orchestration/create`
  never mints a second custody key for the same user, because two keys means
  funds stranded on an orphaned address. Three independent guards enforce this:
  1. **Key replay** — a completed `idempotencyKey` returns the *original*
     result verbatim (same wallet id, same `isNewWallet`, same `createdAt`),
     so a retry after a dropped response is a no-op. Reusing a key for a
     different `userId`/`network` is a `409`
     (`WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT`) rather than a cross-tenant
     leak.
  2. **In-flight reservation** — a key currently being processed is rejected
     with `WALLET_ORCHESTRATION_IDEMPOTENCY_IN_PROGRESS` (also `409`) so two
     concurrent retries cannot both mint. The reservation is released in a
     `finally`, so one transient failure never poisons a key.
  3. **Natural-key guard** — one wallet per `(userId, network)`. Even with no
     idempotency key, a repeat call returns the existing wallet with
     `isNewWallet: false` instead of creating a duplicate.
- The orchestration surface is **deny-by-default**: it requires an API key
  (`ApiKeyGuard`) and is gated behind `FEATURE_WALLET_ORCHESTRATOR`
  (`FeatureFlagGuard`). Only the exact string `true` enables it.
- A dependency outage returns `503` unchanged rather than being masked as a
  `500`, so the calling orchestrator can retry a request that would succeed.
- Private key material never crosses the service boundary: the orchestration
  result carries no `privateKey` field.
- Invariants are gated in CI by `verify-orchestrator-retries.sh` and covered by
  `src/wallets/wallet-creation-orchestrator.service.spec.ts` and
  `test/wallet-orchestration.e2e-spec.ts`.
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

## Soroban invoke orchestration

`SorobanInvokeService` (`src/soroban/`) orchestrates contract calls on a
wallet's behalf.

### Invariants

1. **The backend orchestrates; the client requests.** A client supplies an
   intent — an allowlisted contract *name*, a function, and arguments. The
   server resolves the contract id, bounds-checks the arguments, simulates, and
   signs with the custody key. A client can never supply a contract id or a
   pre-signed transaction.
2. **Explicit allowlist.** Only `(contract, function)` pairs in
   `ALLOWED_CONTRACT_FUNCTIONS` are invocable. An open "invoke any contract the
   client names" surface turns the backend into a generic relay for arbitrary
   third-party code, which is not a wallet.
3. **Arguments are bounds-checked before the network is touched.** Arity,
   per-argument Soroban type, argument count and total serialized size are
   validated locally, so a malformed request never costs an RPC round trip.
4. **Simulate before submit.** Every invoke is simulated first. A predicted
   revert returns a failure with `SOROBAN_SIMULATION_REVERTED` and **nothing is
   submitted**.
5. **Fee bounds are server-side.** A client may lower the fee it will pay but
   never raise it: a `maxFee` above the server ceiling is refused. A fee below
   the floor is refused because a dust invoke is an RPC griefing vector.
6. **Network is enforced.** A function with `mainnetEnabled: false` is refused
   on mainnet with `SOROBAN_FUNCTION_NOT_ENABLED`, so an unaudited contract
   cannot be driven at mainnet value.
7. **Deny-by-default authz and kill-switch.** Owner/guardian/API-key may invoke;
   a delegate is refused. `SOROBAN_INVOKE_ENABLED` defaults to off.
8. **Fail-closed on outage.** An unreachable RPC or contract registry refuses the
   invoke; it never falls through to submitting an unsimulated transaction.
9. **No key material anywhere.** Logs, metrics and responses carry contract
   names, function names, ids and correlation ids only.

### Endpoints

All routes require an API key (`ApiKeyGuard`, deny-by-default). Invoking
additionally requires `SOROBAN_INVOKE_ENABLED=true`.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/soroban/contracts?network=…` | Allowlisted functions usable on a network. |
| `POST` | `/v1/soroban/invoke` | Orchestrate a contract call. Body: `{ contract, functionName, args, network, simulateOnly?, maxFee? }`. |

### Error codes

| Code | Status | Meaning |
|------|--------|---------|
| `SOROBAN_INVOKE_INVALID_INPUT` | 400 | Malformed contract, function, args, or fee. |
| `SOROBAN_ARGUMENT_MISMATCH` | 400 | Arity or per-argument type does not match the signature. |
| `SOROBAN_FEE_TOO_LOW` | 400 | `maxFee` is below the server floor. |
| `SOROBAN_CONTRACT_NOT_ALLOWED` | 403 | Contract is not in the allowlist. |
| `SOROBAN_FUNCTION_NOT_ALLOWED` | 403 | Function is not allowlisted on that contract. |
| `SOROBAN_FUNCTION_NOT_ENABLED` | 403 | Function is not enabled on the requested network. |
| `SOROBAN_INSUFFICIENT_ROLE` | 403 | Role may not invoke contracts. |
| `SOROBAN_REQUEST_TOO_LARGE` | 413 | Too many arguments, or the payload exceeds the size budget. |
| `SOROBAN_INVOKE_DISABLED` | 503 | `SOROBAN_INVOKE_ENABLED` is not `true`. |
| `SOROBAN_RPC_UNAVAILABLE` | 503 | Soroban RPC or contract registry unavailable; the invoke is refused. |

A simulated revert is **not** an HTTP error: it returns `status: "FAILED"` with
`errorCode: "SOROBAN_SIMULATION_REVERTED"` and `200`, because the request was
well-formed and the *simulation* reported the failure.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SOROBAN_INVOKE_ENABLED` | `false` | Kill-switch for all invokes. Only `true`/`1` enables. |
| `MAX_INVOKE_ARGS` | `16` | Maximum arguments per invoke. |
| `MAX_INVOKE_ARG_BYTES` | `8192` | Maximum serialized argument size. |
| `MIN_INVOKE_FEE_STROOPS` | `100` | Server fee floor. |
| `MAX_INVOKE_FEE_STROOPS` | `1000000` | Server fee ceiling. |

### Port bindings

`SOROBAN_RPC` and `CONTRACT_REGISTRY` are intentionally **not** bound in
`SorobanInvokeModule`. Both belong to the custody/network layer that owns the
wallet keys and the Soroban endpoint. Until a deployment binds them,
`SorobanInvokeService` fails to construct and the surface is unreachable —
fail-closed by absence, rather than fail-open with a stub that would "succeed"
without ever reaching the chain. Do not add default implementations here.

### Rollback

Set `SOROBAN_INVOKE_ENABLED=false` and redeploy. No schema change, so no data
migration. Allowlist discovery (`GET /v1/soroban/contracts`) keeps working so
clients can render correct UIs while the surface is disabled.

## Multi-asset payment matrix

`AssetMatrixService` (`src/payments/asset-matrix.ts`) decides which asset a
payment may carry. This section documents the implementation behind the
asset-code allowlist and `PAYMENT_ASSET_CODE_UNAVAILABLE` referenced elsewhere in
this document.

### Invariants

1. **The matrix is the allowlist.** An asset absent from `ASSET_MATRIX` is
   refused with `PAYMENT_ASSET_UNKNOWN`. There is no "if it looks like a valid
   Stellar asset, accept it" path — accepting an unreviewed issuer is how an im

## Contributor checklist (Stellar Wave)

`AssetMatrixService` (`src/payments/asset-matrix.ts`) decides which asset a
payment may carry. This section documents the implementation behind the
asset-code allowlist and `PAYMENT_ASSET_CODE_UNAVAILABLE` referenced elsewhere in
this document.

### Invariants

1. **The matrix is the allowlist.** An asset absent from `ASSET_MATRIX` is
   refused with `PAYMENT_ASSET_UNKNOWN`. There is no "if it looks like a valid
   Stellar asset, accept it" path — accepting an unreviewed issuer is how an
   impersonation token gets spent.
2. **Issuer is part of the identity.** A credit asset is identified by
   `(code, issuer)`, never by code alone. A known code with an unrecognised
   issuer is refused with `PAYMENT_ASSET_ISSUER_MISMATCH`; this is the check
   that blocks a look-alike token reusing a legitimate code.
3. **Network is enforced.** A matrix entry marked `mainnetEnabled: false` is
   refused on mainnet with `PAYMENT_ASSET_NOT_ENABLED`. A testnet asset can
   never settle on mainnet, even when its code and issuer are otherwise valid.
4. **Native XLM carries no issuer.** `XLM` with an `assetIssuer` is refused — a
   caller must not be able to assert a "native" asset that is not native. An
   absent `assetCode` still means native, so existing native payments are
   unaffected.
5. **Amounts are strings, precision-checked.** Amounts are validated in the
   asset's smallest unit as a decimal string, never as a JS `number`, so a
   large or 7-decimal amount is not silently rounded. An amount with more
   fractional digits than the asset allows is **refused**
   (`PAYMENT_AMOUNT_INVALID`), not truncated — silently rounding sends a
   different amount than the user asked for.
6. **Fail-closed on the flag.** Credit-asset writes require
   `MULTI_ASSET_PAYMENTS_ENABLED`. Native XLM is unaffected: the flag gates
   *new* asset exposure and must not break the existing money path.
7. **Code length fits the type.** `CREDIT_ALPHANUM4` takes 1-4 characters and
   `CREDIT_ALPHANUM12` takes 5-12; a mismatch is
   `PAYMENT_ASSET_CODE_LENGTH_INVALID`, because such a payment could never
   settle on-chain.

### Error codes

| Code | Status | Meaning |
|------|--------|---------|
| `PAYMENT_ASSET_INVALID_INPUT` | 400 | Malformed asset code, or an issuer with no code. |
| `PAYMENT_ASSET_UNKNOWN` | 400 | Asset code is not in the matrix. |
| `PAYMENT_ASSET_ISSUER_MISMATCH` | 400 | Issuer is absent or not recognised for the code. |
| `PAYMENT_ASSET_NOT_ENABLED` | 400 | Asset is not enabled on the requested network. |
| `PAYMENT_ASSET_CODE_LENGTH_INVALID` | 400 | Code length does not fit the declared asset type. |
| `PAYMENT_AMOUNT_INVALID` | 400 | Amount is non-positive, non-numeric, or over-precise. |
| `PAYMENT_MULTI_ASSET_DISABLED` | 503 | `MULTI_ASSET_PAYMENTS_ENABLED` is not `true`. |
| `PAYMENT_ASSET_CODE_UNAVAILABLE` | 503 | Asset metadata unavailable; the write is refused. |

### Adding an asset

Add a row to `ASSET_MATRIX`. A new mainnet asset requires `mainnetEnabled: true`
and a reviewed issuer address — that row is the assertion "this issuer's asset
is acceptable to move money in", so it belongs in a reviewed diff rather than a
runtime chain query. Add a testnet row first with `mainnetEnabled: false` to
exercise it before enabling it on mainnet.

### Observability

Metrics: `payment_asset_rejected`, `payment_asset_unknown`,
`payment_asset_issuer_mismatch`, `payment_asset_not_enabled`,
`payment_amount_precision_exceeded`, `payment_multi_asset_blocked_by_flag`.

A rejected issuer is attacker-supplied, so it is **never** echoed into the error
response or the log line; only the asset code and correlation id are.

### Rollback

Set `MULTI_ASSET_PAYMENTS_ENABLED=false` and redeploy. Native XLM payments
continue to work; credit-asset writes are refused. The `assetCode` column is
additive and requires no data migration.

## Horizon balance reconciliation

`BalanceIndexerService` keeps the `WalletBalance` index in sync with Horizon and
flags any disagreement between the indexed value and the on-chain value.

### Invariants

1. **Horizon is the source of truth for on-chain balances.** The index is a
   cache. Reconciliation *records* a discrepancy (`syncStatus = MISMATCH`,
   `onChainBalance`); it never overwrites the indexed balance. An operator
   decides which side is correct.
2. **Fail-closed on dependency outage.** If Horizon or the balance 

`BalanceIndexerService` keeps the `WalletBalance` index in sync with Horizon and
flags any disagreement between the indexed value and the on-chain value.

### Invariants

1. **Horizon is the source of truth for on-chain balances.** The index is a
   cache. Reconciliation *records* a discrepancy (`syncStatus = MISMATCH`,
   `onChainBalance`); it never overwrites the indexed balance. An operator
   decides which side is correct.
2. **Fail-closed on dependency outage.** If Horizon or the balance store is
   unreachable the call fails with `503 BALANCE_DEPENDENCY_UNAVAILABLE` and
   applies **no** write. A partial or malformed Horizon payload is rejected
   rather than persisted — otherwise an outage would be recorded as "this
   account holds nothing" and would silently zero real balances.
3. **Writes are feature-flagged.** `BALANCE_SYNC_ENABLED` defaults to **OFF**.
   Reads work unflagged; every mutation returns
   `503 BALANCE_FEATURE_FLAG_DISABLED` until an operator opts in.
4. **Amounts are strings.** Balances are compared and stored as decimal strings
   in the asset's smallest unit and never pass through a JS `number`, so
   precision is preserved. Comparison normalizes trailing zeros, so `100`,
   `100.0` and `100.0000000` are the same amount and are not reported as a
   mismatch.
5. **Idempotent.** A replayed sync converges on the same state, and a
   reconciliation over unchanged data produces the same result. A balance
   already synced inside the staleness budget skips the Horizon round trip
   unless `forceRefresh` is set.
6. **Bounded sweeps.** `sync-all` / `reconcile-all` refuse to run over more than
   `MAX_SWEEP_WALLETS` (500) wallets, returning
   `413 BALANCE_BATCH_TOO_LARGE` rather than silently truncating.
7. **Server-side wallet resolution.** Callers supply a wallet *id*; the on-chain
   account is always read from the stored `publicKey`, so a caller cannot point
   the indexer at an account of their choosing.

### Endpoints

All routes require an API key (`ApiKeyGuard`, deny-by-default). Mutating routes
additionally require `BALANCE_SYNC_ENABLED=true`.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/v1/balances/wallet/:walletId` | Cached balances. Scope with `?assetType=NATIVE&assetCode=…&assetIssuer=…`. |
| `GET`  | `/v1/balances/wallet/:walletId/stale` | Balances not refreshed within the staleness budget. |
| `POST` | `/v1/balances/wallet/:walletId/sync` | Refresh one wallet. Body: `{ forceRefresh?: boolean }`. |
| `POST` | `/v1/balances/wallet/:walletId/sync-with-retry` | As `sync`, with bounded backoff on transient failures. Body: `{ forceRefresh?, maxAttempts? }` (max 5). |
| `POST` | `/v1/balances/wallet/:walletId/reconcile` | Reconcile one asset. Body: `{ assetType, assetCode?, assetIssuer? }`. |
| `POST` | `/v1/balances/sync-all` | Refresh every active wallet. |
| `POST` | `/v1/balances/reconcile-all` | Reconcile every active wallet. |
| `POST` | `/v1/balances/scheduled-sync` | Manually trigger the scheduled sweep. |

### Error codes

| Code | Status | Meaning |
|------|--------|---------|
| `BALANCE_INVALID_INPUT` | 400 | `walletId` failed validation (length/character set). |
| `BALANCE_WALLET_NOT_FOUND` | 404 | No wallet with that id. |
| `BALANCE_DEPENDENCY_UNAVAILABLE` | 503 | Horizon or the balance store is unavailable; **no write applied**. |
| `BALANCE_FEATURE_FLAG_DISABLED` | 503 | `BALANCE_SYNC_ENABLED` is not `true`. |
| `BALANCE_BATCH_TOO_LARGE` | 413 | Sweep exceeds `MAX_SWEEP_WALLETS`. |

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BALANCE_SYNC_ENABLED` | `false` | Kill-switch for all balance writes. Only `true`/`1` enables. |
| `BALANCE_STALE_THRESHOLD_MS` | `300000` | How long a balance may go unrefreshed before it is reported stale. |
| `STELLAR_HORIZON_TESTNET_URL` | Horizon testnet | Base URL for testnet reads. |
| `STELLAR_HORIZON_MAINNET_URL` | — | Required when `STELLAR_NETWORK=mainnet`; the client throws rather than falling back. |

An unknown `STELLAR_NETWORK` makes the Horizon client throw, so a misconfigured
deploy cannot reconcile against the wrong chain.

### Observability

Metrics (label values are sanitized; no secrets or key material):
`balance_sync_completed`, `balance_sync_skipped_fresh`, `balance_sync_retry`,
`balance_sync_retry_skipped`, `balance_reconcile_match`,
`balance_reconcile_mismatch`, `balance_reconcile_all_completed`,
`balance_stale_scan`, `balance_scheduled_sync_completed`,
`balance_scheduled_sync_failed`, `balance_horizon_error`, `balance_store_error`,
`balance_write_blocked_by_flag`, `balance_sweep_too_large`,
`balance_wallet_not_found`.

Log lines carry the wallet id, asset type and code only. Stellar account ids are
redacted to a 4-character prefix plus length, so a log line can be correlated
with a Horizon lookup without disclosing a usable account identifier.

### Rollback

Turning `BALANCE_SYNC_ENABLED` off immediately returns the service to read-only.
No schema change is involved — `WalletBalance` and its
`(walletId, assetType, assetCode, assetIssuer)` unique key already exist — so
rollback requires no data migration.

### Testing notes

`BalanceIndexerService` depends on two ports, `BALANCE_STORE` and
`HORIZON_BALANCE_CLIENT`, so unit tests substitute in-memory fakes. Simulate a
Horizon outage by rejecting `fetchAccountBalances`, and a store outage by
rejecting a `BalanceStore` method; both must surface
`BALANCE_DEPENDENCY_UNAVAILABLE` with no write applied.

## Contributor checklist (Stellar Wave)
- [ ] Read this document and the custody security model before changing
      linkage or asset code code.
- [ ] Add unit tests for invariants and auth negatives, including asset code
      allowlist and immutability cases.
- [ ] Add integration/e2e coverage on the payment critical path.
- [ ] Keep CI green for this package; add a required check if ungated.
- [ ] Update runbooks and cross-links when behavior changes.
