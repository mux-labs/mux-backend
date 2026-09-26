# Mainnet Payment Feature Flag & Kill-Switch

This runbook documents the feature flag and kill-switch that gate all
mainnet-affecting payment behavior in `mux-backend`, including the
**payment dry-run mode** described in [`PAYMENT-DRY-RUN.md`](./PAYMENT-DRY-RUN.md).
It is the source of truth for operators and Stellar Wave contributors working
on payment, wallet, and webhook delivery paths.

> Scope: money-path and mainnet-affecting changes only. Testnet behavior is
> unaffected unless explicitly noted.

## Why this exists

Payment dry-run lets clients simulate and validate a payment without
submitting it to Stellar/Horizon. Because dry-run shares the same authz,
idempotency, and validation code paths as live payments, it must be gated so
that a misconfiguration cannot accidentally promote a dry-run into a live
spend, and so operators can disable the money path quickly during an incident.

## Flags

| Flag | Env var | Default | Effect |
| --- | --- | --- | --- |
| Payment dry-run | `PAYMENT_DRY_RUN_ENABLED` | `false` | Enables the dry-run entrypoint. When `false`, dry-run requests are rejected with `PAYMENT_DRY_RUN_DISABLED`. |
| Mainnet payments | `PAYMENT_MAINNET_ENABLED` | `false` | Master switch for live mainnet submission. When `false`, live writes fail closed with `PAYMENT_MAINNET_DISABLED`. |
| Payment kill-switch | `PAYMENT_KILL_SWITCH` | `false` | When `true`, all payment writes (live and dry-run) are rejected immediately with `PAYMENT_KILL_SWITCH_ENGAGED`. |

All flags are **deny-by-default**: unset or unparseable values are treated as
`false`.

- **Deny-by-default.** When unset or `false`, mainnet money-path writes and
  outbound webhook delivery are disabled. Testnet behavior is unaffected.
- **Fail-closed.** If the flag cannot be read (config/RPC/DB outage), treat it as
  `false` and reject the write rather than proceeding.
- **Kill-switch.** Setting the flag to `false` at runtime must stop new mainnet
  writes and webhook deliveries without a redeploy; in-flight retries drain to
  the dead-letter queue instead of being re-sent.

Operational guidance:
- Keep this flag off in production until mainnet payment submission has been reviewed and approved for general availability; flip it on per-environment via env/secret config.

## Feature flags service (#909)

The flags above are served by a single typed feature-flags service. This section
is the contract for that service; it is the source of truth for flag evaluation
and mutation and must stay consistent with the flag table above.

### Evaluation API

- `evaluate(flagKey, context)` returns a typed result: `{ key, enabled, value, source, correlationId }`.
- `evaluateAll(context)` returns a map of `flagKey -> result` for a caller's context.
- Evaluation is **read-only** and never mutates state.
- Unknown or missing flag keys resolve to `enabled: false` (deny-by-default).
  Money-path callers must treat an unknown/missing flag as **off** and fail
  closed; they must never default to `true`.

### Mutation API

- `setFlag(flagKey, value, actor, idempotencyKey)` is the only privileged
  mutation surface. It returns the resulting flag state plus a correlation id.
- Mutations are **deny-by-default**: a caller must present a valid
  owner/delegate/guardian/API-key/JWT credential with the flag-admin role.
  Revoked delegates and expired credentials are rejected before any write.
- The service is the **server-side source of truth**. Client-supplied headers,
  query params, or body fields can never enable a flag; the mainnet flag is
  evaluated server-side only.

### Stable error codes

| Code | Meaning |
| --- | --- |
| `FEATURE_FLAG_NOT_FOUND` | Unknown flag key on a mutation. |
| `FEATURE_FLAG_FORBIDDEN` | Missing/invalid/revoked credential or wrong role. |
| `FEATURE_FLAG_INVALID_VALUE` | Value fails the flag's type/schema. |
| `FEATURE_FLAG_UNAVAILABLE` | Flag store (DB/RPC) unreachable; fail closed. |
| `FEATURE_FLAG_CONFLICT` | Idempotency key reused with a different payload. |

Every error carries a correlation id (request id) so ops can trace a failed
evaluation or mutation without exposing secrets or raw key material.

### Idempotency

- Mutations are idempotent on `(flagKey, idempotencyKey)`. A replayed or
  concurrent request with the same key returns the original result and does not
  re-apply the write.
- Reusing an idempotency key with a **different** payload is rejected with
  `FEATURE_FLAG_CONFLICT`.

### Fail-closed behavior

- If the flag store (DB/RPC) is unavailable, **writes fail closed** with
  `FEATURE_FLAG_UNAVAILABLE`; no partial mutation is applied.
- On read outage, evaluation returns the last-known-safe value, which for
  money-path flags is `false`. There is no default-allow path.
- Testnet vs mainnet misconfig: an unresolved network is treated as denied, not
  as testnet.

### Observability

- `feature_flag_evaluations_total{key,result}` — evaluation outcomes.
- `feature_flag_mutations_total{key,result}` — mutation outcomes.
- `feature_flag_errors_total{code}` — stable error codes emitted.
- Logs include the flag key, actor id, correlation id, and result; they never
  include raw key material, JWTs, or webhook secrets.

### Rollback

- The service is deny-by-default and requires no flag to be safe.
- To stop a bad flag change, set the affected flag back to its safe value
  (`false` for money-path flags) via `setFlag`; no schema migration or redeploy
  is required.
- Full stop remains `PAYMENT_KILL_SWITCH=true` as described below.

## Testnet Faucet Mainnet Gate (#882)

The testnet faucet is a testnet-only surface. It must never dispense funds on mainnet, and it must fail closed when the configured network is unknown or misconfigured.

- Gate rule: faucet requests are allowed only when the resolved network is `TESTNET`. Any other resolved network — `MAINNET`, unset, or unrecognized — is denied.
- Fail-closed on misconfig: an unknown/absent network is treated as denied, not as testnet. There is no default-allow path.
- Stable error codes: denials return a typed error with a stable code (e.g. `FAUCET_MAINNET_BLOCKED` for mainnet, `FAUCET_NETWORK_UNRESOLVED` for unknown/missing network) plus a correlation id so ops can trace the request without exposing secrets.
- Authz: the gate is enforced server-side after authz (owner/delegate/guardian/API-key/JWT). A caller cannot bypass the gate by presenting a valid credential — authorization and the network gate are independent checks, and both must pass.
- Idempotency: replayed/concurrent faucet requests are deduplicated by request id so a retry cannot double-dispense; the gate decision is evaluated before any dispense side effect.
- Dependency outage: if the network/config source (RPC/DB/Horizon) is unavailable, the gate fails closed and denies the request rather than assuming testnet.
- Observability: emit a metric/log on every gate denial with the stable error code and correlation id; never log raw key material, JWTs, or webhook secrets.
- Rollback: the gate is deny-by-default and requires no flag to be safe; disabling the faucet entirely is the rollback path if a regression is suspected.

Cross-links: see `test/testnet-faucet-mainnet-gate.e2e-spec.ts` for the end-to-end coverage of these invariants.

## Transaction Environment Validator (#914)

The `TransactionEnvValidatorService` is a **fail-closed boot-time gate** for
money-path configuration. It runs during NestJS startup (`OnModuleInit`), so a
misconfigured deployment refuses to start instead of silently submitting
mainnet payments to an unknown or testnet Horizon endpoint.

- Gate rule: in `NODE_ENV=production`, if `FEATURE_MAINNET_PAYMENTS` or
  `FEATURE_MAINNET_PAYMENT_SUBMIT` is enabled **and**
  `STELLAR_HORIZON_MAINNET_URL` is missing/empty, startup fails with a stable,
  typed error code (`TRANSACTION_ENV_VALIDATOR_MAINNET_HORIZON_MISCONFIGURED`).
- Deny-by-default: an unset or unrecognized flag value is treated as
  `false`; it can never enable a mainnet surface accidentally.
- Testnet and non-production environments are never blocked by this validator;
  local/test flows with no mainnet config continue to work.
- The validator never logs secrets, keys, JWTs, or webhook secrets; the startup
  snapshot is booleans + stable enum strings only.
- Observed behavior is covered end-to-end in
  `test/transaction-env-validator.e2e-spec.ts` and unit-tested in
  `src/transactions/transaction-env-validator.service.spec.ts`.

Operational guidance: keep `STELLAR_HORIZON_MAINNET_URL` set in production
secret/env config before enabling any mainnet payment flag. The validator is a
safety net for the flags below; the flags remain the operational kill-switch.

## Webhook delivery (retries / idempotency)

Outbound webhook delivery is a money-path-adjacent surface and is gated by the
same flag on mainnet.

- **Idempotency.** Every delivery carries a stable idempotency key derived from
  the event id. Replayed or concurrent deliveries with the same key are deduped
  so side effects happen at most once. Consumers should treat the key as the
  dedupe token.
- **Retries.** Failed deliveries are retried with exponential backoff, bounded
  attempts, and jitter. Exhausted deliveries are moved to the dead-letter queue
  as terminal failures; they are never retried unbounded.
- **Fail-closed on outage.** If RPC/DB/Horizon is unavailable, writes fail
  closed and deliveries are not acknowledged as delivered.
- **Adversarial input.** Oversized batches and spoofed webhooks are rejected
  before any side effect; signatures are verified and secrets are never logged.
- **Observability.** Delivery attempts, retries, dedupe hits, and terminal
  failures emit metrics and structured logs with correlation ids. Webhook
  secrets, JWTs, and key material are redacted.

## Invariants

1. Dry-run **never** submits to Stellar/Horizon. It only validates and returns
   a simulated result.
2. Dry-run and live payments share the same authz checks (owner / delegate /
   guardian / API-key / JWT). Dry-run cannot be used to bypass payment policy.
3. Every dry-run request carries a correlation id and is idempotent on
   `(account, idempotencyKey)`; replays return the original result.
4. On RPC/DB/Horizon outage, writes fail closed. Dry-run may return a
   validation error but must not mutate state.
5. No secrets (keys, JWTs, webhook secrets) are logged; only redacted
   identifiers and correlation ids.
6. The mainnet flag is evaluated **server-side only** and is never trusted from
   client input; a client cannot enable mainnet payments by sending a header,
   query param, or body field.

## Invisible Wallet Orchestration

This flag also gates the invisible-wallet orchestration money path. When the flag is off, orchestration entrypoints that would submit a mainnet spend (fee-bump submit, sponsored create, recovery submit) fail closed with HTTP 403 and the stable error code `MAINNET_PAYMENT_SUBMIT_DISABLED`; no wallet key material is decrypted and no Horizon/RPC call is made. Testnet orchestration is unaffected.

- Behavior and request/response contracts for orchestration are documented in `docs/WALLET-API.md`; this flag is the kill-switch for the mainnet-affecting subset of those flows.
- Authz for orchestration entrypoints is deny-by-default: owner/delegate/guardian/API-key/JWT must be present and valid, and revoked delegates are rejected before any spend is attempted.
- Replayed or concurrent orchestration requests are idempotent via the caller-supplied idempotency key; a duplicate key returns the original result rather than re-submitting.
- Errors carry a correlation id (request id) and the stable error codes above so ops can trace a failed orchestration without exposing secrets or raw key material.

## Kill-switch procedure

1. Set `PAYMENT_KILL_SWITCH=true` and roll the deployment.
2. Confirm rejection metrics: `payments_rejected_total{reason="kill_switch"}`
   increases and `payments_submitted_total` drops to zero.
3. Investigate using correlation ids from structured logs.
4. To restore, set `PAYMENT_KILL_SWITCH=false` and roll back.

## Rollback

- Disable dry-run: `PAYMENT_DRY_RUN_ENABLED=false`.
- Disable live mainnet: `PAYMENT_MAINNET_ENABLED=false`.
- Full stop: `PAYMENT_KILL_SWITCH=true`.
- Set `FEATURE_MAINNET_PAYMENT_SUBMIT=false` (or unset) to immediately stop all mainnet orchestration spends; testnet flows continue to work. No migration or redeploy of wallet state is required.

Each flag is independently reversible without a schema migration.

## Observability

- `payments_dry_run_total{result}` — dry-run outcomes.
- `payments_rejected_total{reason}` — authz/flag/idempotency rejections.
- `payments_submitted_total` — live mainnet submissions.
- `feature_flag_evaluations_total{key,result}` — flag evaluation outcomes.
- `feature_flag_mutations_total{key,result}` — flag mutation outcomes.
- `feature_flag_errors_total{code}` — stable feature-flag error codes.

All metrics and logs carry a correlation id and redact secrets, JWTs, and raw
key material.
