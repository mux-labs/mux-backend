# Maintenance Secret Rotation Runbook (#925)

`MAINTENANCE_ADMIN_SECRET` gates `PATCH /v1/maintenance` — the one control that
can freeze every write in a deployment. Losing access to it during an incident
means being unable to *unfreeze* the service, so it is rotated with an explicit
overlap window rather than swapped in one step.

This runbook complements [`SECURITY.md`](../SECURITY.md). For the webhook
signing-key rotation (a different secret with a similar shape) see
[`webhook-secret-rotation-runbook.md`](webhook-secret-rotation-runbook.md).

---

## Environment variables

| Variable                                       | Required          | Purpose                                                     |
|------------------------------------------------|-------------------|-------------------------------------------------------------|
| `MAINTENANCE_ADMIN_SECRET`                     | Yes in production | Current secret. Compared in constant time.                  |
| `MAINTENANCE_ADMIN_SECRET_PREVIOUS`            | No                | Prior secret, accepted **only** inside the overlap window. |
| `MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT` | No                | ISO-8601 instant after which the previous secret stops working. |

Header: `X-Maintenance-Secret`.

---

## Invariants

Asserted by `src/maintenance/maintenance-secret.service.spec.ts`.

1. **Constant-time comparison.** Both values are SHA-256 hashed to a uniform
   length and compared with `crypto.timingSafeEqual`, so response timing
   reveals neither the secret nor its length.
2. **No expiry ⇒ no previous secret.** A previous secret without a future
   `..._PREVIOUS_EXPIRES_AT` is **not** accepted. An unbounded second
   credential would be a permanent back door.
3. **An unparseable expiry closes the window.** A typo fails closed rather than
   silently extending the previous secret's life.
4. **Deny-by-default.** With no `MAINTENANCE_ADMIN_SECRET` configured, every
   verification fails. There is no fallback credential and no environment
   (including `NODE_ENV=production`) that relaxes this.
5. **No secret ever leaves the module.** Neither the configured nor the
   presented value is logged, returned, or serialized. Callers receive a
   boolean and a stable reason code only.
6. **Maintenance reads fail closed.** If the persisted state cannot be read
   (DB outage), mutating requests are rejected with `503` and
   `MAINTENANCE_STATE_UNAVAILABLE` — never allowed through on an unknown state.


---

## Rotation procedure (no downtime)

1. **Generate** the new value in your secret manager — high entropy, ≥32 bytes:
   `openssl rand -hex 32`.
2. **Stage the overlap.** Set all three variables in the secret manager:
   - `MAINTENANCE_ADMIN_SECRET` = **new** value
   - `MAINTENANCE_ADMIN_SECRET_PREVIOUS` = **old** value
   - `MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT` = now + 1 hour (ISO-8601,
     e.g. `2026-09-28T13:00:00.000Z`)
3. **Deploy.** Both values are accepted. Verify with the *old* value that
   `PATCH /v1/maintenance` still returns `200` — if it does not, abort and
   roll back to the original configuration.
4. **Distribute** the new value to operators and automation.
5. **Close the window** after the grace period: unset
   `MAINTENANCE_ADMIN_SECRET_PREVIOUS` and
   `MAINTENANCE_ADMIN_SECRET_PREVIOUS_EXPIRES_AT`, then redeploy. From this
   point only the new value works.

**Choosing the window length.** Long enough for every operator and CI job to
pick up the new value (one hour is a reasonable default); short enough that a
leaked previous value stops being useful. A forgotten previous value is not a
silent risk — it stops working at its expiry — but it does keep a second
credential alive, so close the window deliberately.

---

## Verifying a rotation

- `GET /v1/maintenance` is public and unaffected by the secret.
- `PATCH /v1/maintenance` with the current secret → `200`.
- `PATCH /v1/maintenance` with the previous secret, inside the window → `200`.
- The same call with the previous secret, after the window → `401`.
- Logs for a rotation-window call carry the reason code `OK_PREVIOUS`, which is
  the signal to alert on an unfinished rotation.

---

## Failure modes

| Situation                                  | Behavior                                            | Operator action                                                  |
|--------------------------------------------|-----------------------------------------------------|------------------------------------------------------------------|
| Automation still on the old secret         | Authorized until the window closes; `401` afterwards | Complete the rotation; do **not** extend the window indefinitely |
| `..._PREVIOUS_EXPIRES_AT` missing          | Previous secret is **not** accepted (fail-closed)   | Set the expiry, or drop the previous secret entirely             |
| `..._PREVIOUS_EXPIRES_AT` unparseable      | Previous secret is **not** accepted (fail-closed)   | Fix the timestamp format (ISO-8601)                               |
| `MAINTENANCE_ADMIN_SECRET` unset           | Every `PATCH` returns `401`; nothing is authorized  | Restore from the secret manager; there is deliberately no fallback |
| DB unavailable while maintenance is enabled | Writes return `503` `MAINTENANCE_STATE_UNAVAILABLE` | Restore DB connectivity; the guard fails closed, not open        |
| `Retry-After` configured                    | Returned in the `Retry-After` header on `503`       | Honor it client-side; do not retry-storm the endpoint            |

---

## Rollback

Rotation is env-only: no migration, no persisted state. To abort, restore the
previous env configuration and redeploy. Because the current secret is checked
first and the previous secret only inside its window, an aborted rotation is
always safe to retry from step 2.

If the secret is suspected compromised, do **not** use the overlap window —
replace `MAINTENANCE_ADMIN_SECRET` outright, unset both previous-secret
variables, and redeploy. That closes the old value immediately at the cost of
a brief lockout for operators still on it.
