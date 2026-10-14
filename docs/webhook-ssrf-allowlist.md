# Webhook SSRF Allowlist — Runbook

Implements the webhook SSRF requirement from
[SECURITY.md](../SECURITY.md) (issue #960).

Outbound webhook delivery is a classic SSRF surface: the endpoint URL is
attacker-supplied input, and the backend makes the request on the attacker's
behalf. Without a target allowlist, a tenant could register
`https://169.254.169.254/latest/meta-data/` (or `https://10.0.0.5:6379/`) and
use the backend as a proxy into the cluster network and its cloud credentials.

## What is enforced

`WebhookUrlAllowlistService` (`src/webhooks/webhook-url-allowlist.service.ts`)
validates every webhook target URL. The invariants, each covered by a unit test
in `webhook-url-allowlist.service.spec.ts`:

| Invariant | Rule | Error code |
| --- | --- | --- |
| Deny-by-default | Host must be listed in `WEBHOOK_ALLOWED_HOSTS` | `WEBHOOK_URL_NOT_ALLOWLISTED` |
| Transport | `https` only; no `http`, `file:`, `gopher:` | `WEBHOOK_URL_SCHEME_NOT_ALLOWED` |
| No internal targets | Loopback, RFC1918, CGNAT, link-local (incl. `169.254.169.254`), IPv6 ULA/link-local/loopback, IPv4-mapped IPv6 | `WEBHOOK_URL_BLOCKED_HOST` |
| Fixed ports | 443 and 8443 only | `WEBHOOK_URL_PORT_NOT_ALLOWED` |
| No credentials in URL | `https://user:pass@host` refused | `WEBHOOK_URL_INVALID` |
| Bounded input | URLs longer than 2048 chars refused | `WEBHOOK_URL_INVALID` |
| Kill-switch | `WEBHOOK_SSRF_PROTECTION_ENABLED=false` refuses everything | `WEBHOOK_URL_NOT_ALLOWLISTED` |

**DNS names are not resolved during validation.** The check is synchronous and
offline, so a registration cannot be turned into a DNS-rebinding or timing
oracle. Operators needing DNS-level pinning should allowlist the resolved host.

## Where it is applied

1. **Write boundary** — `WebhookService.createEndpoint` and
   `WebhookService.updateEndpoint` validate before the row is written, so a
   forbidden URL is never persisted. Covered by
   `webhook-url-allowlist.enforcement.spec.ts`.
2. **Delivery boundary (defense in depth)** —
   `WebhookDispatchService.deliverWebhook` re-validates immediately before the
   socket opens. This protects endpoints that already exist in the database
   (registered before this control, or inserted by a direct DB write). A blocked
   delivery returns `success: false` and increments
   `webhook_delivery_blocked_by_ssrf_allowlist`; it is treated as terminal
   because retrying re-attempts the same forbidden connection.
   Covered by `webhook-dispatch.service.spec.ts`.

Both layers log only the stable code and the host. Full URLs (which may embed a
token in the query string) and webhook secrets are never logged.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WEBHOOK_ALLOWED_HOSTS` | yes | *(empty)* | Comma-separated host allowlist. Empty accepts nothing. |
| `WEBHOOK_BLOCKED_PORTS` | no | *(empty)* | Extra ports to block on top of 443/8443. |
| `WEBHOOK_SSRF_PROTECTION_ENABLED` | no | `true` | `false`/`0`/`off` disables all outbound webhooks. |

Example:

```bash
WEBHOOK_ALLOWED_HOSTS=hooks.acme.com,hooks.acme-eu.com
```

## Operator runbook

**Rolling this out.** Because the allowlist is deny-by-default, set
`WEBHOOK_ALLOWED_HOSTS` *before* deploying, or every new registration starts
failing with `400 WEBHOOK_URL_NOT_ALLOWLISTED`. Audit existing rows first:

```sql
SELECT id, "projectId", url FROM "WebhookEndpoint" WHERE status = 'ACTIVE';
```

Any existing endpoint that is not on the allowlist will stop delivering. Plan the
allowlist to cover all of them, or deactivate and re-register those endpoints
with an approved host.

**Triage.** A spike in `webhook_delivery_blocked_by_ssrf_allowlist` means either
a misconfiguration (legitimate customer host missing from the allowlist) or an
active SSRF attempt. Correlate the `webhook_delivery_blocked_by_ssrf_allowlist`
counter with the `Rejected webhook URL` warn log, which carries the code and
host. If the host is an internal address, treat it as an SSRF attempt and
report it per the disclosure process in [SECURITY.md](../SECURITY.md).

**Rollback / kill-switch.** Set `WEBHOOK_SSRF_PROTECTION_ENABLED=false` to stop
all outbound webhook delivery immediately. This is a full stop, not a bypass —
there is deliberately no setting that disables the check while continuing to
deliver, because that would restore the SSRF hole. Re-enable by setting it back
to `true` and correcting `WEBHOOK_ALLOWED_HOSTS`.

**Mainnet safety.** Webhook delivery is not a money path, but webhook events
announce wallet and transaction state. The control only ever *removes*
destinations; it never adds one, so it cannot widen the blast radius of a
misconfiguration on mainnet.
