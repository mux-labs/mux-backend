# Webhook Signing Secret — Operator Runbook

Status: production runbook for Mux Protocol webhook secrets (mux-backend).
Audience: on-call engineers, security reviewers, and Stellar Wave contributors.

Outbound webhook signing secrets are **never stored in plaintext**. Each
endpoint's secret is derived deterministically from the server-side
`WEBHOOK_SIGNING_KEY` and only a SHA-256 hash is persisted — mirroring how
API keys are stored. This runbook covers day-2 operations: rotation without
downtime, what to do if a secret leaks, and what changed for existing
endpoints.

## 1. Invariants (must always hold)

1. **Never store plaintext secrets.** Every webhook secret is persisted only as a
   salted hash (e.g. `scrypt`/`argon2id`) or a SHA-256 digest of the derived
   secret. The raw secret is shown to the caller exactly once, at creation or
   rotation time, and is never retrievable again.
2. **Constant-time verification.** Incoming webhook signatures are verified with a
   constant-time comparison (`crypto.timingSafeEqual` or equivalent). Never use
   `==`, `===`, or `String.prototype.includes` on secret material.
3. **No secret leakage.** Raw secrets, hashes, salts, and derived key material
   must never appear in logs, metrics, traces, error responses, or crash dumps.
   Log only opaque identifiers (see §5).
4. **Deny-by-default authz.** Every privileged webhook-secret surface (create,
   rotate, revoke, list) requires an authenticated principal with an explicit
   role: `owner`, `delegate`, or `guardian`. API-key/JWT callers are mapped to a
   role before the handler runs; unknown roles are rejected.
5. **Fail-closed.** If the DB, KMS, or RPC dependency is unavailable, rotation
   and verification fail closed (reject) rather than falling back to plaintext or
   skipping the check.
6. **Idempotent rotation.** Rotation is keyed by an idempotency key; replaying the
   same request returns the same result and does not mint a second secret.

## 2. Storage model

| Field            | Type      | Notes                                              |
| ---------------- | --------- | -------------------------------------------------- |
| `id`             | uuid      | Stable identifier, safe to log.                    |
| `secretHash`     | text      | Salted hash (or SHA-256 digest) of the raw secret. Never logged. |
| `secretSalt`     | text      | Per-secret salt. Never logged.                     |
| `algorithm`      | text      | e.g. `scrypt-v1`. Enables future migration.        |
| `rotatedAt`      | timestamp | Last successful rotation.                          |
| `expiresAt`      | timestamp | Grace window for the previous secret (see §4).     |
| `revokedAt`      | timestamp | Null unless explicitly revoked.                    |
| `idempotencyKey` | text      | Unique per rotation request.                       |

A secret is considered **active** when `revokedAt IS NULL AND expiresAt > now()`.

### Secret derivation

| Concept | Details |
|---------|---------|
| Secret derivation | `whsec_` + `base64url(HMAC-SHA256(WEBHOOK_SIGNING_KEY, "webhook-signing:v<version>:<endpointId>"))` |
| At rest | `sha256(secret)` only — never the plaintext, never the master key |
| Established secret | The version currently used to sign outbound deliveries |
| Pending secret | A newer version staged by `rotate-secret`, hashed at rest |
| Grace window | `WEBHOOK_SECRET_GRACE_SECONDS` (default `3600`s). While it is open, deliveries keep being signed with the **established** secret; when it elapses, the pending secret is promoted atomically on the next dispatch |

## 3. Rotation entrypoint

Typed entrypoint (NestJS controller + service):

```ts
// POST /webhooks/:id/rotate
// Headers: Authorization: Bearer <jwt|api-key>, Idempotency-Key: <uuid>
interface RotateWebhookSecretRequest {
  webhookId: string;
  idempotencyKey: string;
  correlationId?: string;
}

interface RotateWebhookSecretResponse {
  webhookId: string;
  secret: string;        // returned ONCE, never persisted in plaintext
  rotatedAt: string;     // ISO-8601
  expiresAt: string;     // ISO-8601, end of grace window
  correlationId: string;
}
```

Stable error codes (do not renumber; clients depend on them):

| Code                       | HTTP | Meaning                                        |
| -------------------------- | ---- | ---------------------------------------------- |
| `WEBHOOK_NOT_FOUND`        | 404  | Unknown webhook id.                            |
| `WEBHOOK_FORBIDDEN`        | 403  | Caller lacks owner/delegate/guardian role.     |
| `WEBHOOK_UNAUTHENTICATED`  | 401  | Missing or expired credential.                 |
| `WEBHOOK_IDEMPOTENCY_REPLAY` | 200 | Same key replayed; returns original result.   |
| `WEBHOOK_DEPENDENCY_UNAVAILABLE` | 503 | DB/KMS/RPC outage; fail-closed.          |
| `WEBHOOK_RATE_LIMITED`     | 429  | Too many rotation attempts.                    |
| `WEBHOOK_INVALID_INPUT`    | 400  | Malformed body or missing idempotency key.     |

Every response (success or error) carries a `correlationId` echoed from the
request or generated server-side. The correlation id is the only identifier
allowed in logs for a rotation attempt.

### Rotating an endpoint's signing secret (routine)

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

## 4. Grace window and verification

1. On rotation, the new secret becomes active immediately.
2. The previous secret remains valid for a bounded grace window (default 24h,
   configurable) so in-flight senders are not broken.
3. Verification tries the active secret first, then the previous secret while it
   is within the grace window. Both comparisons are constant-time.
4. After `expiresAt`, the previous secret is rejected. There is no unbounded
   fallback.
5. Revocation (`revokedAt`) takes effect immediately and overrides the grace
   window.

## 5. Observability (ops-safe)

Allowed log fields: `correlationId`, `webhookId`, `actorRole`, `outcome`,
`errorCode`, `durationMs`.

Forbidden log fields: raw secret, `secretHash`, `secretSalt`, signature bytes,
JWTs, API keys, request bodies containing secrets.

Metrics (labels must be low-cardinality; never label by secret or webhook id):

- `webhook_secret_rotation_total{outcome,error_code}`
- `webhook_secret_rotation_duration_ms` (histogram)
- `webhook_signature_verification_total{outcome}`
- `webhook_secret_active_count` (gauge)
- `webhooks_secrets_rotated_total{result="rotated"}` — rotation calls
- `webhooks_secrets_promoted_total{}` — pending → active switchovers

Alert on sustained `WEBHOOK_DEPENDENCY_UNAVAILABLE` and on any spike in
`webhook_signature_verification_total{outcome="invalid"}`.

## 6. Authz matrix

| Action            | owner | delegate | guardian | api-key | jwt |
| ----------------- | :---: | :------: | :------: | :-----: | :-: |
| Create secret     |  yes  |   yes    |   yes    |  yes*   | yes |
| Rotate secret     |  yes  |   yes    |   yes    |  yes*   | yes |
| Revoke secret     |  yes  |   yes    |   yes    |  yes*   | yes |
| Read secret (raw) |  no   |   no     |   no     |   no    | no  |

\* API keys must be scoped to the webhook's network and owner; unscoped keys
are denied. Reading a raw secret is never permitted after creation/rotation.

## 7. Failure modes and handling

- **Concurrent rotation:** the `idempotencyKey` unique constraint serializes
  writers; the loser returns `WEBHOOK_IDEMPOTENCY_REPLAY` with the winner's
  result.
- **Dependency outage:** return `WEBHOOK_DEPENDENCY_UNAVAILABLE` (503). Never
  write a plaintext fallback and never skip verification.
- **Auth expiry / revoked delegate:** return `WEBHOOK_UNAUTHENTICATED` or
  `WEBHOOK_FORBIDDEN`; do not partially apply the rotation.
- **Spoofed webhook:** signature verification fails closed; the request is
  rejected and counted in the invalid metric.
- **Oversized batch / griefing:** rate-limit rotation per actor and per webhook;
  reject oversized payloads with `WEBHOOK_INVALID_INPUT`.
- **Testnet vs mainnet misconfig:** secrets are network-scoped; a testnet secret
  can never verify a mainnet webhook and vice versa.

## 8. Rollback / kill-switch

Rotation is gated behind the `WEBHOOK_SECRET_ROTATION_ENABLED` feature flag.

- **Disable:** set the flag to `false`. New rotations return
  `WEBHOOK_DEPENDENCY_UNAVAILABLE`; existing secrets keep verifying.
- **Rollback:** redeploy the previous revision. Because secrets are stored
  hashed and versioned by `algorithm`, no data migration is required to roll
  back the application code.
- Document the flag state and rollback steps in the PR description for any
  change touching this path.

## 9. Emergency procedures

### Compromised secret (emergency)

If an endpoint's signing secret leaks (e.g. in logs, a client repo, or a
public gist):

1. Call `POST /v1/webhooks/endpoints/:id/rotate-secret` immediately.
2. Lower `WEBHOOK_SECRET_GRACE_SECONDS` temporarily (or deploy with a short
   window) so the switchover happens quickly.
3. Share the new secret with the endpoint owner out-of-band.
4. Confirm the old secret stops being used by checking delivery
   `X-Webhook-Signature` values after the window.

### Compromised WEBHOOK_SIGNING_KEY (emergency)

Because secrets are derived from the master key, exposing it compromises every
endpoint. Plan:

1. Deploy a new `WEBHOOK_SIGNING_KEY` (new value, ≥ 32 chars).
2. For **every** endpoint call `rotate-secret` and distribute each returned
   secret to its owner. (New secrets derive from the new key.)
3. During each rotation's grace window, deliveries are signed with the
   *established* secret — which still derives from the **old** key until the
   window elapses. Expect a short transition, then full switchover.

## 10. Environment

| Variable | Required | Notes |
|----------|----------|-------|
| `WEBHOOK_SIGNING_KEY` | Yes (boot fails without it) | ≥ 32 chars. Never log it, never put it in a commit. If it is ever exposed, rotate it and re-issue every endpoint secret (see §9). |
| `WEBHOOK_SECRET_GRACE_SECONDS` | No (default `3600`) | Grace window for rotation switchover. |

The master key lives **outside** the database. Back it up with the same
discipline as `WALLET_ENCRYPTION_KEY` — losing it means derived secrets
cannot be recomputed and outbound signatures break.

## 11. Migration for endpoints created before this feature

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

## 12. Verification

```bash
# Confirm no plaintext secrets are stored
docker compose exec db psql -U mux -d mux_db -c \
  "SELECT id, \"secretVersion\", \"secretHash\", \"pendingSecretVersion\" FROM \"WebhookEndpoint\";"

# secretHash should be a 64-char hex digest (sha256) — never a whsec_ value.
```

Logs never contain the signing secrets, API keys, or
`WALLET_ENCRYPTION_KEY`; secret-shaped fields are redacted by `SafeLogger`.

## 13. Manual checklist (when automation cannot cover)

- [ ] Rotate a secret on testnet; confirm the old secret still verifies within
      the grace window and fails after `expiresAt`.
- [ ] Confirm the raw secret appears exactly once in the response and never in
      logs or metrics.
- [ ] Confirm an unscoped API key is denied on a network-scoped webhook.
- [ ] Confirm rotation fails closed with the DB/KMS stopped.
- [ ] Confirm the kill-switch disables new rotations without breaking existing
      verification.

## 14. References

- `test/webhooks.e2e-spec.ts` — end-to-end coverage for verification and rotation.
- `docs/MAINNET-PAYMENT-FEATURE-FLAG.md` — feature-flag conventions.
- `SECURITY.md` — disclosure and secret-handling policy.
