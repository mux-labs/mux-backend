# Soroban RPC Retry Policy

The Soroban invoke orchestrator is **fail-closed**: any RPC error refuses the
invoke with `SOROBAN_RPC_UNAVAILABLE`, and an unsimulated transaction is never
submitted. That is the correct default, but on its own it is brittle — a single
dropped connection, a `429` from an overloaded RPC, or a `5xx` during a ledger
close is indistinguishable from a real outage, so a blip fails a request that
would have succeeded 200ms later.

`src/soroban/soroban-rpc-retry.ts` adds a bounded retry policy that separates
**transient** failures (the same call would plausibly succeed shortly) from
**permanent** ones (the answer will not change).

## The one rule that matters

**A read is retried; a write is not — by default.**

`simulate` is a pure read and is retried. `submit` mutates chain state, and a
transport error there is *ambiguous*: the transaction may well have landed even
though the response was lost. Retrying it blindly risks submitting the same
transaction twice. So submission retries are **opt-in**:

```
SOROBAN_RPC_RETRY_SUBMIT=false   # default
```

Only set it to `true` if your RPC layer guarantees idempotent submission (for
example, a submission keyed by a deterministic transaction hash that the network
rejects as a duplicate). If you cannot state that guarantee, leave it off.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SOROBAN_RPC_MAX_ATTEMPTS` | `3` | Total attempts including the first. Clamped to `[1, 10]`. |
| `SOROBAN_RPC_RETRY_BACKOFF_MS` | `200` | Base backoff. Capped at `10000`. |
| `SOROBAN_RPC_DEADLINE_MS` | `5000` | Total wall-clock budget for all attempts and waits. |
| `SOROBAN_RPC_RETRY_SUBMIT` | `false` | Opt in to retrying a mutating `submit`. |

Every value is **clamped, not rejected**: a typo in an integer variable should
not take down a deployment that is otherwise fine, and each bound is a safety
ceiling rather than a correctness requirement.

## What counts as transient

Retried:

- HTTP status `408`, `425`, `429`, `500`, `502`, `503`, `504`
- transport errors: `ECONNRESET`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`,
  `EAI_AGAIN`, `SocketError`, `NetworkError`, `TimeoutError`, …

Not retried:

- every other `4xx` — the request is wrong and will stay wrong
- known permanent error names (`BadRequestError`, `ContractError`, `SdkError`, …)
- **an unrecognized error.** Classification fails closed: anything not positively
  identified as transient is treated as permanent, because blindly retrying an
  unknown failure is how a retry storm starts
- an abort (client disconnected)

## Behaviour

- **Bounded attempts and a bounded total delay**, capped independently. A
  misconfigured attempt count or a large backoff cannot turn one request into
  unbounded RPC load.
- **Exponential backoff with full jitter** — a uniform draw from
  `[0, base * 2^(n-1)]`, capped. Full jitter rather than a fixed delay, so a
  fleet recovering from one blip does not resynchronize into a thundering herd.
- **Abort signal respected.** A client that disconnects mid-retry stops the work
  instead of continuing to hammer an RPC that is already struggling.
- **Deadline enforced.** If the next attempt would land outside the caller's
  budget, the loop stops rather than converting a fast failure into a slow one.
- **Never throws for an RPC failure.** The helper returns
  `{ outcome, attempts, value?, error? }` so the caller keeps ownership of the
  stable error code. `simulate` exhaustion and `submit` failure both still
  surface as `SOROBAN_RPC_UNAVAILABLE`.

## Invariants

1. Simulate-before-submit is unchanged. A simulation that ultimately fails —
   whether immediately or after exhausting retries — **never** becomes a
   submission.
2. The server remains the source of truth. Retries re-issue the *same* validated
   request; they never re-derive arguments, fees, or a contract id.
3. No key material in logs. Retry logs carry contract name, function, attempt
   count, outcome, and correlation id only.
4. No secret leakage in classification: only status codes and error names are
   inspected, never error messages.

## Metrics

Ops-safe counters with no user-derived labels:

- `soroban_rpc_retry_simulate` / `soroban_rpc_retry_submit` — one per retry
- `soroban_rpc_retry_exhausted` — the budget ran out (needs `attempts > 1`)
- `soroban_rpc_unavailable` — total simulate failures reaching the caller
- `soroban_rpc_submit_failed` — submit failed

A sustained `soroban_rpc_retry_simulate` with a healthy success rate is normal
and expected — that is the policy absorbing blips. Alert on
`soroban_rpc_retry_exhausted` and `soroban_rpc_submit_failed`, which mean the
budget was not enough.

## Tests

- `src/soroban/soroban-rpc-retry.spec.ts` — policy resolution, error
  classification, backoff/jitter, and the retry loop
- `src/soroban/soroban-invoke.service.spec.ts` — the policy exercised through
  `SorobanInvokeService`, including the duplicate-submission guard and
  fail-closed exhaustion

## Rollback

Set `SOROBAN_RPC_MAX_ATTEMPTS=1` to disable retries entirely without a code
change — the policy respects it and the surface behaves exactly as it did before
this change. Reverting the code is equally safe: there is no schema, no
migration, and no chain state to unwind. To disable contract invocation
outright, set `SOROBAN_INVOKE_ENABLED=false`.

Related: [WALLET-API.md](WALLET-API.md), [FEATURE-FLAGS.md](FEATURE-FLAGS.md),
[SOROBAN-CONTRACT-ID-BOOT.md](SOROBAN-CONTRACT-ID-BOOT.md),
[../SECURITY.md](../SECURITY.md).

---
