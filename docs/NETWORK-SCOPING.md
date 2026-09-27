# Network Scoping & `NETWORK_MISMATCH`

How the backend refuses a request that targets the wrong Stellar network, and
the stable error code clients branch on.

Reference issue: **#943 — Network mismatch stable errorCode**.
Related: [`docs/API-VERSIONING.md`](./API-VERSIONING.md) (error-code stability
policy), [`SECURITY.md`](../SECURITY.md).

## Why this exists

Mux settles value on two mutually incompatible networks. A TESTNET-scoped
credential acting on MAINNET — or a MAINNET payment reinterpreted as TESTNET —
is a money-path failure, not a cosmetic one: assets minted on the wrong chain
are not recoverable from this backend. The rule is therefore enforced by the
server, before any handler runs, and it fails closed.

## Invariants

1. **`network: null` means "all networks".** This is the documented meaning of
   `ApiKey.network = null` in `prisma/schema.prisma`. It is not an unknown
   value to be guessed at.
2. **A scoped credential only ever acts on its own network.** TESTNET is not
   MAINNET; no configuration, header, or role makes them interchangeable.
3. **Enforcement happens in the guard**, i.e. before the handler. A mismatched
   request never reaches the orchestrator, the payment path, or the database
   write path.
4. **Fail closed on unparseable input.** An unrecognised network value
   (`localnet`, `testnet-`, a number) is refused rather than defaulted.
5. **No key material in the error or the logs.** The `subject` in an error is a
   static label such as `api-key`, never the key, its hash, or a token.

## Stable error codes

Defined in `src/common/network/network-mismatch.ts` as
`NetworkErrorCode`:

| Code | Status | Meaning |
|------|--------|---------|
| `NETWORK_MISMATCH` | `403` | The credential/resource is scoped to a different network than the request targets. |
| `INVALID_NETWORK` | `400` | The requested network is not a recognised value at all. |

Every denial carries a `correlationId`: the caller's `x-request-id` when
present, otherwise a generated UUID. Clients should branch on `code`, never on
the human-readable message.

```json
{
  "code": "NETWORK_MISMATCH",
  "message": "This api-key is scoped to TESTNET and cannot be used on MAINNET",
  "correlationId": "3f0c…"
}
```

## How the target network is resolved

`extractRequestedNetwork()` looks, in order of specificity:

1. `x-mux-network` header — lets an operator pin the network at the edge.
2. `body.network`
3. `params.network`
4. `query.network`

If the request does not name a network, no scope check is performed (which is
a no-op for unscoped keys and cannot widen a scoped key, because a scoped key
with no named network still has no way to reach a handler that targets the
other chain without naming it).

## Where it is enforced

- `ApiKeyGuard` — runs on every protected route, so an API key can never cross
  its scope boundary. See `src/api-keys/api-key.guard.ts`.
- `ApiKeyService.assertNetworkAllowed()` — programmatic check for services that
  already hold a validated context.
- Unit coverage: `src/common/network/network-mismatch.spec.ts`.
- End-to-end coverage: `test/network-mismatch.e2e-spec.ts`.

## Operational notes

- Re-scoping a key is not possible: create a new key with the desired scope and
  revoke the old one (revocation is immediate — see `SECURITY.md`).
- The checks are pure and emit no metrics of their own; the guard's denial is
  logged with the correlation id only, so no secrets enter the log stream.
