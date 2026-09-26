# Horizon Retry & Fail-Closed Writes (#952)

Horizon is the source of truth for on-chain balances. This document describes how
`HorizonRestBalanceClient` retries transient Horizon failures **without ever
turning an outage into a balance write**.

* Implementation: `src/balance-indexer/horizon-retry.policy.ts`
* Client: `src/balance-indexer/horizon-rest-balance.client.ts`
* Consumer: `src/balance-indexer/balance-indexer.service.ts`
* Tests: `src/balance-indexer/horizon-retry.policy.spec.ts`,
  `src/balance-indexer/horizon-rest-balance.client.spec.ts`

## Invariants

1. **Reads only.** The retry helper wraps a single `GET /accounts/:id`. It is
   never applied to a write, so a retry cannot double-apply a balance mutation.
2. **Transient only.** `408`, `429` and `5xx`, plus transport failures
   (`ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, …) are retried. Every other `4xx`
   (e.g. `404` for a closed account) is permanent and surfaces immediately.
3. **Bounded + jittered.** Exponential backoff (`base × 2ⁿ⁻¹`) with bounded
   jitter, a hard cap of `MAX_HORIZON_RETRIES` (10), and a wall-clock budget
   (`STELLAR_HORIZON_RETRY_BUDGET_MS`, default 15 s). A misconfigured value
   falls back to the documented default rather than retrying forever.
4. **`Retry-After` honoured.** When Horizon returns a `Retry-After` header the
   delay is taken from it (falling back to the exponential schedule).
5. **Fail-closed.** If every attempt fails, the client throws a typed
   `HorizonRetryExhaustedError`. It never resolves with an empty or partial
   snapshot, because the indexer treats a resolved snapshot as authoritative
   and would otherwise persist `0` over real balances.
6. **No secrets in logs/metrics.** Only attempt counts, HTTP statuses and error
   class names are emitted. Account ids are redacted to a short prefix by the
   indexer; URLs, headers and response bodies are never logged.

## Failure mapping

| Condition | Result |
|-----------|--------|
| Transient failure, later attempt succeeds | Snapshot returned; `balance_horizon_retry` incremented per retry |
| All attempts transient-failed | `HorizonRetryExhaustedError` → service surfaces `503 BALANCE_DEPENDENCY_UNAVAILABLE`; **no write** |
| Permanent `4xx` | Original error immediately; **no retry**, no write |
| Malformed `200` payload | Treated as permanent (`DEPENDENCY_MALFORMED` path); **no write** |
| Unsupported/unset `STELLAR_NETWORK`, or mainnet without `STELLAR_HORIZON_MAINNET_URL` | Throws before any request; **no write** |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `STELLAR_HORIZON_MAX_RETRIES` | `3` | Retries after the initial attempt (clamped to 10) |
| `STELLAR_HORIZON_RETRY_BACKOFF_MS` | `500` | Base delay for exponential backoff |
| `STELLAR_HORIZON_RETRY_JITTER_MS` | `250` | Maximum jitter added per retry |
| `STELLAR_HORIZON_RETRY_BUDGET_MS` | `15000` | Upper bound on total time per read |
| `STELLAR_HORIZON_TESTNET_URL` / `STELLAR_HORIZON_MAINNET_URL` | testnet default / unset | Network-scoped Horizon endpoints |
| `BALANCE_SYNC_ENABLED` | `false` | Kill-switch for balance **writes** (reads always allowed) |

## Operations

* **Metric `balance_horizon_retry`** rising without `balance_sync_completed`
  rising is the signal that Horizon is degraded but still reachable.
* **Metrics `balance_horizon_retry_exhausted` + `balance_horizon_error`** rising
  means Horizon is down: balance freshness degrades, and (by design) no write is
  applied. The index simply goes stale — it does not go wrong.
* **Rollback / kill-switch.** Set `BALANCE_SYNC_ENABLED=false` to stop all
  balance writes immediately while keeping reads available. Retries themselves
  can be reduced to a single attempt by setting `STELLAR_HORIZON_MAX_RETRIES=0`.

See also: [Horizon balance reconciliation](WALLET-API.md#horizon-balance-reconciliation),
[README § Balance Indexer](../README.md#balance-indexer).
