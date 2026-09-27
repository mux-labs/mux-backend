# Security Policy

## Reporting a Vulnerability

Please report suspected vulnerabilities privately to the Mux security team at
`security@muxprotocol.io`. Do not open public issues for security reports.
Include a description, reproduction steps, affected components, and any
correlation ids observed. We aim to acknowledge reports within 72 hours.

## Scope

This policy covers the `mux-backend` service, including the wallet
orchestrator, account-abstraction entrypoints, and all external HTTP/RPC
surfaces. The server and on-chain contracts remain the source of truth for
spends, recovery, and admin actions; clients cannot bypass policy.

## Feature Flags and Kill Switches

Money-path and mainnet-affecting behavior is gated behind feature flags and
kill switches. The wallet orchestrator flag is documented in
[`docs/FEATURE-FLAGS.md`](docs/FEATURE-FLAGS.md),
[`docs/AUTH-FEATURE-FLAGS.md`](docs/AUTH-FEATURE-FLAGS.md), and
[`docs/MAINNET-PAYMENT-FEATURE-FLAG.md`](docs/MAINNET-PAYMENT-FEATURE-FLAG.md).
End-to-end coverage for the orchestrator flag lives in
`test/wallet-orchestrator-feature-flag.e2e-spec.ts`.

Invariants enforced by the flag path:

- **Deny-by-default.** New privileged surfaces are disabled unless explicitly
  enabled for the target environment. Testnet and mainnet configuration are
  evaluated independently; a testnet flag never enables mainnet behavior.
- **Fail-closed on writes.** If the flag store, RPC, DB, or Horizon is
  unavailable, money-path writes are rejected rather than allowed.
- **Authz before effect.** Owner/delegate/guardian/API-key/JWT checks run
  before any orchestrator action; revoked delegates and expired credentials
  are rejected with stable error codes.
- **Idempotency.** Concurrent or replayed requests are deduplicated so a flag
  transition cannot double-apply a spend or recovery action.

## Authorization

Every external entrypoint is authenticated and authorized. Requests carry a
correlation id that is propagated through logs and error responses to aid
incident response. Stable error codes are returned for auth failures so
clients can distinguish expiry, wrong role, and revoked delegate without
leaking policy internals.

## Secrets and Logging

- No secrets, tokens, or credentials are committed to this repository.
- Logs and metrics redact raw key material, JWTs, API keys, and webhook
  secrets. Never log full request bodies for privileged endpoints.
- Observability is ops-safe: metrics and structured logs expose actionable
  errors and money/realtime path signals without sensitive payloads.

## Rate Limiting

External entrypoints touched by the orchestrator flag are rate-limited and
authorized. Oversized batches and griefing-style inputs are rejected before
reaching money-path logic.

## Rollback

Flag and kill-switch changes are reversible. Rollback steps and the readiness
checklist for mainnet-affecting changes are documented in the PR description
and the referenced runbooks.
