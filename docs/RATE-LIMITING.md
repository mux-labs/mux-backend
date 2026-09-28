# Rate-Limiting Strategy — Auth & Payments (#926)

This document is the contract for how `mux-backend` bounds abuse on its two
most abuse-prone surfaces: **credential endpoints** and **money movement**. It
complements — and does not replace — [`SECURITY.md`](../SECURITY.md)
(§ *Rate Limiting*) and
[`docs/DEVELOPER-QUOTAS.md`](DEVELOPER-QUOTAS.md).

---

## Why tiers exist

Two other mechanisms already bound throughput, and neither is an abuse
control:

| Mechanism            | Scope                              | Question it answers              |
|----------------------|------------------------------------|----------------------------------|
| `RATE_LIMIT_RPM`     | Per API key                        | "How much may this key send?"    |
| `DeveloperQuotaGuard`| Per developer, across all keys     | "How much may this tenant send?" |
| **Tiers (this doc)** | Per surface, independent of tenant | "How much may an *attacker* send?" |

A tenant can raise its own quota, so a quota cannot bound credential stuffing
or a burst of payment attempts. The tier is chosen from the **request path**,
not from tenant configuration, and a strict tier can only be tightened — never
loosened past the default ceiling.

---

## Tiers

| Tier       | Surfaces                                                     | Keyed by | Default      | Overrides                                             |
|------------|--------------------------------------------------------------|----------|--------------|-------------------------------------------------------|
| `auth`     | `/auth/login`, `/auth/register`, `/auth/verify`, `/auth/refresh`, `/auth/challenge`, `/v1/auth/*` | Client **IP** | 10 / 60s  | `AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`     |
| `payments` | `/v1/payments*`, `/v1/transactions*`                          | API key  | 60 / 60s     | `PAYMENT_RATE_LIMIT_MAX`, `PAYMENT_RATE_LIMIT_WINDOW_MS` |
| `default`  | Everything else                                               | API key  | 600 / 60s    | tenant `RATE_LIMIT_RPM`                               |

**Why the auth tier is IP-keyed.** Credential endpoints are reached *before* an
API key exists. Keying them by API key would make them unthrottled for exactly
the traffic that does not have one.

**Why transactions join the payments tier.** Transaction submission moves
money and consumes Horizon/RPC capacity, so it draws on the same budget as
payments.

---

## Invariants

These are asserted by `src/rate-limit/rate-limit.policy.spec.ts`.

1. **Deny-by-default on misconfiguration.** A missing, zero, negative,
   non-integer, or non-numeric limit resolves to the tier's built-in default —
   never to "unlimited" and never to zero. A deployment with no configuration
   is still protected.
2. **Stricter tiers can only tighten.** `auth` and `payments` limits are
   clamped to the `default` ceiling, so a typo that *raises* a limit cannot
   open the money path.
3. **No route escapes limiting.** Path classification is deny-by-default in
   effect: an unrecognised path lands in `default`, which is still rate
   limited. Adding a route never leaves it unthrottled.
4. **Stable error contract.** Every refusal is HTTP `429` with the stable code
   `RATE_LIMITED` plus the tier name, so clients and dashboards can branch on
   it without parsing prose.
5. **No secrets in the policy surface.** The ops snapshot
   (`rateLimitPolicySnapshot`) exposes limits, windows, and keying only — never
   credentials.

---

## Failure modes

| Situation                              | Behavior                                                                                  | Operator action                                                                 |
|----------------------------------------|-------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------|
| `AUTH_RATE_LIMIT_MAX=0`                | Falls back to 10/60s (limit is never disabled)                                             | Fix the value; check the deployed env matches `.env.example`                    |
| `AUTH_RATE_LIMIT_MAX=abc`              | Falls back to 10/60s and logs nothing sensitive                                             | Same                                                                              |
| `PAYMENT_RATE_LIMIT_MAX=100000`        | Clamped to the `default` ceiling (600/60s)                                                  | Raise `default` deliberately instead, after a capacity review                   |
| A new route added                      | Classified `default` — still limited                                                        | Classify it explicitly if it is auth- or money-bearing                           |
| Legitimate traffic burst               | `429` + `RATE_LIMITED`; client retries with backoff                                          | Raise the tier limit, or shard the caller across keys                            |

---

## Where the tiers are enforced

`RateLimitGuard`
([`src/rate-limit/rate-limit.guard.ts`](../src/rate-limit/rate-limit.guard.ts))
is registered as a global `APP_GUARD`, so every request is classified and
counted. The guard holds no policy of its own: it calls
`resolveRateLimitTier()` and `resolveRateLimitPolicy()` and enforces exactly
what they return, so tightening a tier in configuration tightens it here.

Subject selection:

- the `auth` tier counts per **client address** (`request.ip`, falling back to
  the socket's remote address). Headers a client controls, such as
  `X-Forwarded-For`, are deliberately not trusted — a spoofable address would
  let an attacker mint a fresh budget per request. Terminate the limit at a
  trusted proxy if the deployment needs proxy-aware client IPs;
- every other tier counts per **server-resolved API-key id**. A request with no
  resolved key falls back to its own address rather than to a shared constant
  bucket, so one unauthenticated caller can never exhaust another's budget.

The tracked-subject map is bounded per tier
(`MAX_TRACKED_SUBJECTS = 10_000`); at the cap the least-recently-seen entry is
evicted, which costs that caller a fresh window rather than a refusal.

`@SensitiveEndpoint()` remains available to mark a route explicitly, but it is
not required: an unrecognised path still lands in `default` and is still
limited.

---

## Observability

Log/metric fields (values only, no credentials):

- `rateLimitTier_auth_limit`, `rateLimitTier_payments_limit`, `rateLimitTier_default_limit`
- `rateLimitTier_*_windowMs`, `rateLimitTier_*_keyedByIp`
- On refusal: the tier name, the correlation id, and the limit — never the
  presented API key.

Alert on a sustained `429` rate for the `auth` tier: it is the signature of
credential stuffing rather than of a misconfigured client.

---

## Rollback

The tiers are configuration, not schema. To roll back, revert the env values
and redeploy; there is no migration and no persisted state. Rolling **back to
no configuration at all** is safe — the built-in defaults still apply.
