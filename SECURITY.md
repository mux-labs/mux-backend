# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Mux Protocol, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email us at **security@muxprotocol.io** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept if possible)
- Affected components (contracts, backend, SDK, frontend)
- Any suggested remediation

We will acknowledge receipt within 48 hours and aim to provide a resolution timeline within 5 business days. We ask that you give us reasonable time to address the issue before public disclosure.

## Scope

This policy covers:

- Soroban smart contracts (`mux-contracts`)
- Backend services and APIs (`mux-backend`)
- SDKs and client libraries
- Web application

## Internal Cron Jobs & Secret Guard

Internal, cron-triggered endpoints (cleanup workers, reconciliation jobs, and other
scheduled maintenance tasks) are **not** part of the public API surface. They are
guarded by a shared cron secret and are **deny-by-default**: if the secret is
missing, unset, or does not match, the request is rejected before any job logic
runs.

### Configuration

- `CRON_SECRET` — required shared secret used to authenticate internal cron
  triggers. Must be a high-entropy random value (e.g. 32+ bytes, base64/hex
  encoded). Never commit this value to the repository.
- The secret is supplied to the backend via environment/secret manager only.
  It must never appear in source, logs, error responses, or metrics.
- Cron callers must present the secret on every request (e.g. via the
  `x-cron-secret` header). Requests without a valid secret receive a stable
  `401`/`403` error code and are not executed.

### Rotation

1. Generate a new high-entropy secret in the secret manager.
2. Update the cron scheduler / trigger configuration to send the new value.
3. Roll the backend deployment so it reads the new `CRON_SECRET`.
4. Verify scheduled jobs still succeed and that unauthenticated requests are
   rejected.
5. Revoke the previous secret.

Rotation should be performed on a regular schedule and immediately if a secret
is suspected to be compromised. Because the guard is fail-closed, a missing or
mismatched secret disables the internal jobs rather than exposing them.

### Operational Notes

- Auth failures are logged with a correlation/request id and a stable error
  code, but **never** log the secret value or raw key material.
- Internal job endpoints are rate-limited and idempotent; replayed or
  concurrent triggers must not cause duplicate side effects.
- On dependency outages (RPC/DB/Horizon), internal write paths fail closed.

## Container Hardening

The production `Dockerfile` runs the API as a non-root user (`mux`, UID 1001)
and applies defense-in-depth controls. This section documents the
invariants and operational expectations.

### Invariants

1. The container **never runs as root**. The `mux` user (UID 1001) owns
   all application files and executes the process.
2. New privileges are **denied at runtime** (`no-new-privileges:true`).
   The container cannot gain additional Linux capabilities after start.
3. The production image is **minimal**: only runtime dependencies,
   built artifacts, and Prisma migrations are present. Build tools,
   source code, and dev dependencies are excluded.
4. Secrets are **never baked into the image**. They are injected at
   runtime via environment variables or a secret manager.
5. Migration failures are **fail-closed**: `docker-entrypoint.sh` exits
   non-zero if `prisma migrate deploy` fails, so orchestrators
   (Kubernetes, ECS) detect the failure and restart rather than running
   against a stale schema.
6. No secrets, JWTs, or raw key material appear in container logs,
   error responses, or metrics.

### Operational notes

- For local development, `docker compose up --build` runs the `api`
  service as user `mux` (UID 1001). Use `docker compose exec --user
  root api sh` only for debugging, and never in production.
- For Kubernetes/ECS, apply the same `USER` and `securityOpt` settings
  from `docker-compose.yml`, and consider `readOnlyRootFilesystem`
  with `tmpfs` for `/tmp` and Prisma cache writes.

## Security Best Practices for Contributors

- Never commit secrets, private keys, or credentials to the repository.
- Use environment variables or a secret manager for all sensitive configuration.
- Follow the principle of least privilege for all service accounts and API keys.
- Keep dependencies up to date and review security advisories regularly.
- All privileged surfaces are deny-by-default; new internal entrypoints must be
authorized and rate-limited before they are exposed.

### Fee Sponsorship Budgets

Fee sponsorship budgets control how much a sponsor is willing to pay in
transaction fees on behalf of a sponsored wallet. This is a money-path
surface and must be treated with extra care.

- All fee sponsorship write endpoints are gated by the `FEE_SPONSORSHIP_ENABLED`
  feature flag for mainnet. Default OFF (fail-closed).
- Authz is enforced on every operation: only the wallet owner or an authorized
  delegate/guardian may manage budgets.
- Idempotency keys prevent concurrent/replayed requests from creating duplicate
  budgets or double-spending.
- No secrets, JWTs, or raw key material appear in fee sponsorship logs, error
  responses, or metrics.
- See [README.md](README.md#fee-sponsorship-budgets) for the full API reference
  and operational guidance.

## Stellar Wave Contributors

If you are contributing through Stellar Wave, please review this document and
the relevant runbooks before touching money-path or mainnet-affecting code.
Changes to internal cron guards, authz, or secret handling must include tests
covering the auth negatives and be landed behind a feature flag or kill-switch
when they affect production behavior.

## Supported Versions

We provide security updates for the latest release of each component. Please
ensure you are running a supported version before reporting issues.

## Recognition

We appreciate the efforts of security researchers and contributors who help
keep Mux Protocol and its users safe. With your permission, we will acknowledge
your contribution in our security acknowledgements.
