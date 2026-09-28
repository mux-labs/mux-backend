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

The correlation id (`X-Request-ID`) is resolved once per request and shared by
the access log, the error envelope, and outbound webhooks, so one identifier
traces a request end to end. A client-supplied id is honoured only when it is
short and log-safe; anything else is replaced server-side, preventing log
injection through a spoofed header.

## Secrets and Logging

- No secrets, tokens, or credentials are committed to this repository.
- Logs and metrics redact raw key material, JWTs, API keys, and webhook
  secrets. Never log full request bodies for privileged endpoints.
- Observability is ops-safe: metrics and structured logs expose actionable
  errors and money/realtime path signals without sensitive payloads.

## Rotation

Privileged secrets are rotated with an explicit overlap window so an operator
is never locked out mid-rotation, and so a previous value cannot silently
become a permanent second credential. A previous secret is accepted only while
its expiry is in the future; a missing or unparseable expiry closes the window
(fail-closed).

| Secret                                | Runbook                                                                 |
|---------------------------------------|-------------------------------------------------------------------------|
| `MAINTENANCE_ADMIN_SECRET`            | [docs/MAINTENANCE-SECRET-ROTATION.md](docs/MAINTENANCE-SECRET-ROTATION.md) |
| Webhook signing key                   | [docs/webhook-secret-rotation-runbook.md](docs/webhook-secret-rotation-runbook.md) |

## Rate Limiting

External entrypoints touched by the orchestrator flag are rate-limited and
authorized. Oversized batches and griefing-style inputs are rejected before
reaching money-path logic.

Requests are additionally classified into path-derived **tiers** (`auth`,
`payments`, `default`) that are independent of tenant configuration, so a
tenant cannot raise its own abuse ceiling. The `auth` tier is keyed by client
IP because no API key exists at a credential endpoint. Refusals use the stable
code `RATE_LIMITED`. See [docs/RATE-LIMITING.md](docs/RATE-LIMITING.md).

## Local Development Data

The demo seed writes placeholder wallets and fabricated transactions. It
refuses to run against production, mainnet, or a non-local database so demo
data cannot reach a real environment. See
[docs/SEED-SAFETY.md](docs/SEED-SAFETY.md).

## Rollback

Flag and kill-switch changes are reversible. Rollback steps and the readiness
checklist for mainnet-affecting changes are documented in the PR description
and the referenced runbooks.
