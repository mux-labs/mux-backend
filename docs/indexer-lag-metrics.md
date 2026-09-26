# Balance indexer lag alerting (#959)

Implements the indexer-lag requirement from [SECURITY.md](../SECURITY.md) (issue #959).

The balance indexer keeps a local copy of on-chain balances. When it falls
behind, every read served from the index is wrong — a user can be shown a stale
balance while a payment is in flight. Staleness was already *marked*
(`BalanceSyncStatus.STALE`) but never *reported as a number*, so an operator had
no way to answer "how far behind is the index?" or to alert on it.

## What is reported

`BalanceLagCalculator.compute()` (`src/balance-indexer/balance-indexer-lag.ts`)
turns indexed balance rows into a lag report:

| Field | Meaning |
| --- | --- |
| `rowsScanned` | Rows inspected (capped at `MAX_LAG_SCAN_ROWS`). |
| `neverSynced` | Rows with no `lastSyncedAt` at all. |
| `maxLagMs` | Age of the oldest row, in ms. |
| `medianLagMs` | Median age across rows, in ms. |
| `bucket` | Coarse bucket from the fixed `LAG_BUCKETS` set. |
| `breaching` | Worst lag exceeded the alert threshold. |
| `thresholdMs` | Resolved threshold, echoed for explainability. |

Surfaces:

- `GET /balances/lag` — whole index
- `GET /balances/lag/:walletId` — one wallet
- Emitted on every `detect_stale` run via `BalanceIndexerMetricsService.recordLag`

## Invariants

1. **Fail-closed on a bad store.** A store failure raises
   `BALANCE_LAG_DEPENDENCY_UNAVAILABLE` and returns `503`. It does **not**
   report a lag of `0` — a database outage that looked like a healthy index
   would silently disable the alerting this exists to provide. "Fresh" and
   "unmeasurable" must be distinguishable.
2. **A never-synced row is maximally stale.** A row with no `lastSyncedAt`
   reports `breaching: true` and bucket `24h+`. A missing index row must never
   read as fresh.
3. **Bounded work.** At most 10 000 rows are scanned per report, so a large
   index cannot turn a metrics call into an outage.
4. **Bounded metric labels.** Only `bucket` (a fixed 9-value enum) and
   `breaching` (a boolean) are usable as labels. Wallet ids, public keys, and
   asset issuers never are, so lag metrics cannot explode Prometheus series
   counts — consistent with `MetricsLabelGuardService`.
5. **No identifiers in the output.** The report is counts and durations only. A
   test asserts the report's key set and that no wallet id or public key can
   appear in it, since it is logged verbatim.
6. **Never emits `NaN`.** A malformed timestamp is rejected with
   `BALANCE_LAG_MALFORMED_TIMESTAMP` rather than poisoning a histogram. A
   *future* timestamp (clock skew) collapses to `0s` rather than going negative
   and firing a bogus alert.
7. **Fail-closed threshold.** `BALANCE_LAG_ALERT_THRESHOLD_MS` that is missing,
   unparsable, zero, or negative falls back to the 300 000 ms default, so a typo
   cannot disable alerting.

## Operator runbook

**Alerting.** Fire on `balance_indexer_lag_breach_total` increasing, or on a
report where `breaching: true`. Expected lag on mainnet is bounded by the sync
interval (`BALANCE_SYNC_INTERVAL_MS`, default 10 minutes) plus Horizon latency,
so the default 5-minute threshold fires on a single missed sync — tune
`BALANCE_LAG_ALERT_THRESHOLD_MS` to your sync cadence.

**Triage.** A breach with `neverSynced: 0` means rows exist but are old →
check Horizon reachability and the scheduled sync. A breach with
`neverSynced > 0` means rows are missing entirely → check whether wallet
creation completed, since a wallet that never indexed will report unbounded lag
forever until its first successful sync.

**`503` on the lag endpoint** means the balance store is unreachable. This is
deliberate and fail-closed: treat it as a dependency outage and page, rather
than reading it as "no lag".

**Rollback.** The change is purely additive observability: a new read-only
endpoint, a new pure calculation module, and one extra metric line. It changes
no write path and no money-path behaviour, so reverting the commit is safe at
any time. No feature flag is required — the report is read-only and cannot
affect fund movement.
