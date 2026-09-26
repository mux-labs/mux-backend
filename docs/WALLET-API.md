# Wallet API behavior

All Wallet API routes require a valid API key and are rate-limited. The API
never returns encrypted key material on read endpoints. The only operation
that returns a `privateKey` is a successful first wallet-creation response;
clients must consume it immediately and must not expect it to be replayed.

## Endpoints

| Method | Route | Behavior |
| --- | --- | --- |
| `POST` | `/wallets` | Creates one active wallet per user/network pair. Duplicate user/network requests return `409`. |
| `GET` | `/wallets` | Lists wallets. Supports `userId`, `network`, `status` filters and `limit`/`offset` pagination (default `limit=20`, max `100`). Returns `{ data, total, limit, offset, hasMore }`. |
| `GET` | `/wallets/:id` | Returns a wallet or `404`. |
| `GET` | `/wallets/:id/status` | Returns lifecycle status without decrypting the private key. |
| `PATCH` | `/wallets/:id` | Updates wallet lifecycle status. |
| `PATCH` | `/wallets/:id/activate` | Activates a `PROVISIONING` wallet. Any other current state is rejected. |
| `DELETE` | `/wallets/:id` | Removes a wallet record. |
| `POST` | `/wallets/orchestration/create` | Runs the provisioning flow and accepts an optional `idempotencyKey`. |
| `GET` | `/wallets/orchestration/user/:userId/:network` | Returns the wallet for a user/network pair or `404`. |
| `GET` | `/wallets/orchestration/validate/:userId/:network` | Reports whether a new wallet may be created. |

`network` is `TESTNET` or `MAINNET`. `POST /wallets/orchestration/create`
creates a wallet as `PROVISIONING`, then promotes it to `ACTIVE` in the same
database transaction. Testnet funding is best effort: a disconnected or
failed Friendbot call is logged and does not undo a committed wallet.

## Idempotency

For orchestration creation, an `idempotencyKey` is scoped to one
`userId`/`network` operation for 24 hours.

- Repeating the same operation returns the cached wallet result with
  `privateKey: ""`.
- Reusing the key for another user or network returns `409`.
- Expired keys are treated as new requests.

## Lifecycle events

The API emits webhook domain events after state has been durably persisted:
`wallet.created`, `wallet.activated`, `wallet.suspended`, and
`wallet.rotated`. Event dispatch is asynchronous; a webhook outage is logged
but never changes the response or rolls back wallet state. Creation events
from the orchestration endpoint are emitted only after its database
transaction commits, and are not repeated for idempotency replays.

## Dependency retries and metrics

Before any wallet write, transient key-management and testnet-funding failures
are retried with capped exponential backoff. Invalid requests and non-transient
4xx responses are not retried. Configure this behavior with:

| Variable | Default |
| --- | --- |
| `WALLET_API_RETRY_MAX_ATTEMPTS` | `3` |
| `WALLET_API_RETRY_BASE_DELAY_MS` | `100` |
| `WALLET_API_RETRY_MAX_DELAY_MS` | `2000` |

Wallet operations write structured `[wallet-api-metrics]` log records with
operation, outcome, duration, and network. Metrics intentionally exclude user
and wallet identifiers so they are safe to aggregate as low-cardinality
telemetry.

## Wallet creation sponsorship limits

Wallet creation spends **sponsor** resources: the base-reserve XLM the sponsor
fronts for a new account, plus the transaction fee. Without a cap on how much a
caller may consume, a single actor can loop create requests across many user ids
and drain the sponsor account. That is an availability incident on the money
path, not a nuisance error.

`WalletSponsorshipLimiter` (`src/wallets/wallet-sponsorship-limits.ts`) enforces
per-user and deployment-wide caps inside the orchestrator's transaction,
immediately before the wallet is minted and **before** the testnet faucet is
touched — so a refused request spends nothing.

### Invariants

1. **Fail-closed by default.** Sponsorship is *enabled with default caps* when
   nothing is configured. The failure mode of a missing variable must be
   "default caps", never "no caps".
2. **A bad value never widens the allowance.** An unparsable, zero, or negative
   cap falls back to the default. A typo cannot remove the control.
3. **Check and consume are one step.** Usage increments on admission, so two
   concurrent callers cannot both observe "one slot left" and both take it.
4. **Replay spends nothing.** The gate runs *after* the idempotency and
   existing-wallet checks, so a retried request or a get-or-create never
   consumes a user's allowance.
5. **The window rolls forward.** Usage resets once the window elapses, so a long
   outage cannot permanently block wallet creation.
6. **The kill-switch only removes.** `WALLET_SPONSORSHIP_ENABLED=false` refuses
   sponsored creation outright. There is no value of the flag that lifts the
   caps while continuing to sponsor.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WALLET_SPONSORSHIP_ENABLED` | `true` | `false`/`0`/`off`/`no` refuses sponsored creation. |
| `WALLET_MAX_SPONSORED_WALLETS_PER_USER` | `5` | Per-user cap per window. |
| `WALLET_MAX_SPONSORED_WALLETS_GLOBAL` | `1000` | Deployment-wide cap per window. |
| `WALLET_SPONSORSHIP_WINDOW_MS` | `86400000` (24h) | Accounting window. |

### Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `WALLET_SPONSORSHIP_PER_USER_LIMIT_REACHED` | 429 | This user's allowance is exhausted. |
| `WALLET_SPONSORSHIP_GLOBAL_LIMIT_REACHED` | 429 | The deployment allowance is exhausted. |
| `WALLET_SPONSORSHIP_DISABLED` | 429 | Sponsorship is switched off. |
| `WALLET_SPONSORSHIP_DEPENDENCY_UNAVAILABLE` | 429 | The caller could not be attributed; refused rather than admitted. |

A 429 (not a 500) is deliberate: the condition is a policy decision that clears
when the window rolls, so a client should back off and retry rather than treat
it as a server fault.

### Scope and limitations

The counter is held **in process**, matching the orchestrator's existing
in-process idempotency design. It therefore bounds a single deploy's exposure,
not a fleet-wide total: a multi-replica deployment enforces the cap per replica.
This is documented rather than papered over — a durable, exactly-once version
needs a shared counter, which is a schema change and out of scope here. The
per-user cap is the load-bearing control for the drain scenario, since the
attacker in that scenario varies the *user id*, not the replica.
