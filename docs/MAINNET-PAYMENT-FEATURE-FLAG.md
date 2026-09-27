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

## Wallet Orchestrator Feature Flag (#989)

The wallet orchestrator is the server-side component that coordinates wallet
creation, account-abstraction (AA) operations, and payment submission. Because
it sits on the money path, its behavior is gated by the same deny-by-default
feature-flag contract described above and is covered end-to-end by
`test/wallet-orchestrator-feature-flag.e2e-spec.ts`.

### Gate rule

- The orchestrator evaluates its flag **server-side only**. Client-supplied
  headers, query params, or body fields can never enable the orchestrator; the
  flag is resolved from the feature-flags service, never from request input.
- When the orchestrator flag is unset, `false`, or unknown, the orchestrator
  fails closed: it rejects the request with `WALLET_ORCHESTRATOR_DISABLED` and
  performs no wallet/AA/payment side effect.
- The orchestrator flag is independent of, and subordinate to, the payment
  kill-switch. `PAYMENT_KILL_SWITCH=true` rejects orchestrator writes with
  `PAYMENT_KILL_SWITCH_ENGAGED` even when the orchestrator flag is enabled.

### Stable error codes

| Code | Meaning |
| --- | --- |
| `WALLET_ORCHESTRATOR_DISABLED` | Orchestrator flag is off/unknown; request denied. |
| `WALLET_ORCHESTRATOR_FORBIDDEN` | Missing/invalid/revoked credential or wrong role. |
| `WALLET_ORCHESTRATOR_UNAVAILABLE` | Flag store (DB/RPC) unreachable; fail closed. |
| `WALLET_ORCHESTRATOR_CONFLICT` | Idempotency key reused with a different payload. |

Every error carries a correlation id (request id) so ops can trace a denied
orchestrator request without exposing secrets or raw key material.

### Authz

- Orchestrator entrypoints are **deny-by-default**: a caller must present a
  valid owner/delegate/guardian/API-key/JWT credential with the orchestrator
  role. Revoked delegates and expired credentials are rejected before any
  wallet/AA/payment side effect.
- Authorization and the feature-flag gate are independent checks; both must
  pass. A valid credential cannot bypass a disabled orchestrator flag.

### Idempotency

- Orchestrator writes are idempotent on `(operation, idempotencyKey)`. A
  replayed or concurrent request with the same key returns the original result
  and does not re-apply the wallet/AA/payment side effect.
- Reusing an idempotency key with a **different** payload is rejected with
  `WALLET_ORCHESTRATOR_CONFLICT`.

### Fail-closed behavior

- If the flag store (DB/RPC) is unavailable, orchestrator writes fail closed
  with `WALLET_ORCHESTRATOR_UNAVAILABLE`; no partial wallet/AA/payment mutation
  is applied.
- On read outage, the orchestrator treats its flag as `false`. There is no
  default-allow path.
- Testnet vs mainnet misconfig: an unresolved network is treated as denied, not
  as testnet.

### Observability

- `wallet_orchestrator_requests_total{result}` — orchestrator request outcomes.
- `wallet_orchestrator_errors_total{code}` — stable error codes emitted.
- Logs include the flag key, actor id, correlation id, and result; they never
  include raw key material, JWTs, or webhook secrets.

### Rollback

- The orchestrator is deny-by-default and requires no flag to be safe.
- To stop a bad orchestrator change, set the orchestrator flag back to `false`
  via `setFlag`; no schema migration or redeploy is required.
- Full stop remains `PAYMENT_KILL_SWITCH=true` as described below.

Cross-links: see `test/wallet-orchestrator-feature-flag.e2e-spec.ts` for the
end-to-end coverage of these invariants.

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
