# Graceful Shutdown & Payment Drain (#950)

How `mux-backend` stops without abandoning in-flight payments.

* Implementation: `src/common/shutdown/graceful-shutdown.service.ts`,
  `src/common/shutdown/drain-in-progress.interceptor.ts`
* Wiring: `src/main.ts` (global interceptor + `enableShutdownHooks()`),
  `Dockerfile` (`STOPSIGNAL SIGTERM`), `docker-compose.yml` (`stop_grace_period`)
* Tests: `src/common/shutdown/graceful-shutdown.service.spec.ts`

## Invariants

1. **Writes fail closed during drain.** On `SIGTERM`/`SIGINT` the process marks
   itself draining *before* awaiting in-flight work, and every mutating request
   (`POST`/`PUT`/`PATCH`/`DELETE`) is refused with
   `503 SHUTDOWN_IN_PROGRESS` (`retryable: true` in the
   [error-code catalog](ERROR-CODES.md)).
2. **Reads stay available.** `GET`/`HEAD`/`OPTIONS` (including health and
   readiness) keep working so a load balancer can observe the drain and stop
   routing.
3. **In-flight work wins.** Operations registered with
   `GracefulShutdownService.trackOperation(label)` are awaited up to
   `GRACEFUL_SHUTDOWN_TIMEOUT_MS` (default 25 s) before the process exits.
4. **Bounded.** The drain never blocks forever; on timeout the remaining count is
   logged (`shutdown drain timed out … remaining=N`) and the process exits, after
   which the orchestrator escalates to `SIGKILL`.
5. **No secrets.** Only operation labels, counts and timings are logged.

## Sequence

```
orchestrator                Nest                        Postgres
     │ SIGTERM ──────────────►│
     │                        │ beforeApplicationShutdown(signal)
     │                        │   markDraining()   ← new writes now 503
     │                        │   drain(timeout)   ← wait for tracked work
     │  (requests still in flight complete here)
     │                        │ onApplicationShutdown()
     │                        │   PrismaService.$disconnect()
     │◄── process exits ──────│
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | `25000` | Max time to wait for in-flight work (clamped to 300 000) |
| `GRACEFUL_SHUTDOWN_DRAIN_ENABLED` | `true` | Set to `false` only for local debugging; leaves in-flight work abandoned |

Set the container's `terminationGracePeriodSeconds` / `stop_grace_period`
**strictly greater** than `GRACEFUL_SHUTDOWN_TIMEOUT_MS` (compose uses `30s`
against the `25s` default) so the app exits before `SIGKILL`.

## Adding a money-path operation

```ts
const release = this.shutdown.trackOperation('payment.submit');
try {
  // the existing critical section — unchanged
} finally {
  release(); // idempotent; safe to call twice
}
```

## Operations

* **Rollout check.** During a deploy, `POST`/`PUT`/`PATCH`/`DELETE` requests to
  a draining replica return `503 SHUTDOWN_IN_PROGRESS` with `retryAfterSeconds`.
  Clients should back off and retry — the write was *not* applied.
* **Metric `shutdown_write_rejected`** counts requests refused by the drain gate.
* **Log `shutdown drain complete`** means a clean drain; **`shutdown drain timed
  out … remaining=N`** means work was still in flight and should be reconciled.

## Rollback

Set `GRACEFUL_SHUTDOWN_DRAIN_ENABLED=false` (the process then exits immediately
on the signal, as before this change) or revert this PR. The flag is read at
shutdown time, so no restart of the other replicas is required.
