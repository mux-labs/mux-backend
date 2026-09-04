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
