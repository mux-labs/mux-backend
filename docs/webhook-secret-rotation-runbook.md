# Webhook Signing Secret — Operator Runbook

Outbound webhook signing secrets are **never stored in plaintext**. Each
endpoint's secret is derived deterministically from the server-side
`WEBHOOK_SIGNING_KEY` and only a SHA-256 hash is persisted — mirroring how
API keys are stored. This runbook covers day-2 operations: rotation without
downtime, what to do if a secret leaks, and what changed for existing
endpoints.

## How it works

| Concept | Details |
|---------|---------|
| Secret derivation | `whsec_` + `base64url(HMAC-SHA256(WEBHOOK_SIGNING_KEY, "webhook-signing:v<version>:<endpointId>"))` |
| At rest | `sha256(secret)` only — never the plaintext, never the master key |
| Established secret | The version currently used to sign outbound deliveries |
| Pending secret | A newer version staged by `rotate-secret`, hashed at rest |
| Grace window | `WEBHOOK_SECRET_GRACE_SECONDS` (default `3600`s). While it is open, deliveries keep being signed with the **established** secret; when it elapses, the pending secret is promoted atomically on the next dispatch |

## Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `WEBHOOK_SIGNING_KEY` | Yes (boot fails without it) | ≥ 32 chars. Never log it, never put it in a commit. If it is ever exposed, rotate it and re-issue every endpoint secret (below). |
| `WEBHOOK_SECRET_GRACE_SECONDS` | No (default `3600`) | Grace window for rotation switchover. |

The master key lives **outside** the database. Back it up with the same
discipline as `WALLET_ENCRYPTION_KEY` — losing it means derived secrets
cannot be recomputed and outbound signatures break.

## Rotating an endpoint's signing secret (routine)

```
POST /v1/webhooks/endpoints/:id/rotate-secret
```

1. The response contains the **new plaintext secret exactly once** — store it
   and share it with the endpoint owner (their webhook receiver must verify
   with this value).
2. Until `WEBHOOK_SECRET_GRACE_SECONDS` elapses, deliveries are still signed
   with the previous secret, so consumers that have not switched yet keep
   verifying successfully. **No downtime.**
3. After the window, the new secret becomes active automatically. No further
   action is needed.

Repeated rotations within the grace window are allowed and simply stage a
newer version; the previously returned pending secret is superseded.

## Compromised secret (emergency)

If an endpoint's signing secret leaks (e.g. in logs, a client repo, or a
public gist):

1. Call `POST /v1/webhooks/endpoints/:id/rotate-secret` immediately.
2. Lower `WEBHOOK_SECRET_GRACE_SECONDS` temporarily (or deploy with a short
   window) so the switchover happens quickly.
3. Share the new secret with the endpoint owner out-of-band.
4. Confirm the old secret stops being used by checking delivery
   `X-Webhook-Signature` values after the window.

## Compromised WEBHOOK_SIGNING_KEY (emergency)

Because secrets are derived from the master key, exposing it compromises every
endpoint. Plan:

1. Deploy a new `WEBHOOK_SIGNING_KEY` (new value, ≥ 32 chars).
2. For **every** endpoint call `rotate-secret` and distribute each returned
   secret to its owner. (New secrets derive from the new key.)
3. During each rotation's grace window, deliveries are signed with the
   *established* secret — which still derives from the **old** key until the
   window elapses. Expect a short transition, then full switchover.

## Migration for endpoints created before this feature

The migration (`20260831000000_hash_webhook_secrets`) drops the old plaintext
`secret` column. Pre-existing rows are backfilled with `secretVersion = 1`
and an empty `secretHash` (filled lazily on first dispatch). The previous
random plaintext secrets **cannot be re-derived**, so:

1. For each endpoint that existed before the migration, call
   `POST /v1/webhooks/endpoints/:id/rotate-secret`.
2. Share the returned secret with the endpoint owner and have them update
   their stored value.
3. Until they do, deliveries are signed with the derived v1 secret — which
   they do not hold — so update them before the grace window elapses.

This only affects endpoints created before the migration; new endpoints are
fully derived from day one.

## Verification

```bash
# Confirm no plaintext secrets are stored
docker compose exec db psql -U mux -d mux_db -c \
  "SELECT id, \"secretVersion\", \"secretHash\", \"pendingSecretVersion\" FROM \"WebhookEndpoint\";"

# secretHash should be a 64-char hex digest (sha256) — never a whsec_ value.
```

Metrics emitted (Prometheus):

- `webhooks_secrets_rotated_total{result="rotated"}` — rotation calls
- `webhooks_secrets_promoted_total{}` — pending → active switchovers

Logs never contain the signing secrets, API keys, or
`WALLET_ENCRYPTION_KEY`; secret-shaped fields are redacted by `SafeLogger`.
