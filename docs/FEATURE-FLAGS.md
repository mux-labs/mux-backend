# Feature Flags

Mux Backend uses `FEATURE_*` environment variables to gate its core API surfaces.

## Default Behaviour

**All flags default to `true` (enabled) when unset.** A fresh deploy with no `FEATURE_*` variables set will expose all core APIs. This prevents accidental outages due to missing configuration.

To disable a feature, explicitly set its environment variable to `false`:

```
FEATURE_AUTH=false
```

Any other value (`true`, `1`, `yes`, unset/empty) keeps the feature enabled.

## Available Flags

| Environment Variable          | API Surface                              | Default  |
|-------------------------------|------------------------------------------|----------|
| `FEATURE_AUTH`                | `/v1/auth/**` — authentication endpoints | enabled  |
| `FEATURE_WALLETS`             | `/v1/wallets/**` — wallet management     | enabled  |
| `FEATURE_PAYMENTS`            | `/v1/payments/**` — payment endpoints    | enabled  |
| `FEATURE_WEBHOOKS`            | `/v1/webhooks/**` — webhook management   | enabled  |
| `FEATURE_TRANSACTIONS`        | `/v1/transactions/**` — transactions     | enabled  |
| `FEATURE_LIMITS`              | `/v1/limits/**` — spending limits        | enabled  |
| `FEATURE_KEY_MANAGEMENT`      | `/v1/key-management/**` — key ops        | enabled  |
| `FEATURE_MAINNET_PAYMENTS`    | Mainnet payment processing (extra gate)  | enabled  |
| `FEE_SPONSORSHIP_ENABLED`     | Fee sponsorship budget writes on mainnet | **disabled** (deny-by-default) |
| `MULTI_ASSET_PAYMENTS_ENABLED` | Credit-asset payment writes (non-native) | **disabled** (deny-by-default) |
| `KEY_ROTATION_ENABLED`        | Wallet `keyVersion` rotation writes     | **disabled** (deny-by-default) |
| `BALANCE_SYNC_ENABLED`        | Horizon balance sync/reconcile writes   | **disabled** (deny-by-default) |

## Production vs Development

The `FeatureFlagService` behaves consistently across all environments:

- **Unset** → enabled (safe default for fresh deploys)
- **Set to `false`** → disabled (the API returns 503/404 — it is never silently mocked)

In production, the service emits a `WARN` log for every explicitly-disabled flag at startup so operators have clear visibility.

## Reading Flags in Code

Inject `FeatureFlagService` from `FeatureFlagModule`:

```typescript
import { FeatureFlagService } from 'src/common/feature-flags/feature-flag.service';

@Injectable()
export class MyService {
  constructor(private readonly flags: FeatureFlagService) {}

  doSomething() {
    if (this.flags.isDisabled('PAYMENTS')) {
      throw new ServiceUnavailableException('Payments are currently disabled');
    }
    // ...
  }
}
```

`FeatureFlagModule` exports `FeatureFlagService`; add it to the `imports` array of any module that needs it.

## Typed Evaluation API

`FeatureFlagService` exposes a typed evaluation surface with stable error codes and
correlation ids so callers and operators can trace every decision.

```typescript
export type FeatureFlagName =
  | 'AUTH'
  | 'WALLETS'
  | 'PAYMENTS'
  | 'WEBHOOKS'
  | 'TRANSACTIONS'
  | 'LIMITS'
  | 'KEY_MANAGEMENT'
  | 'MAINNET_PAYMENTS';

export enum FeatureFlagErrorCode {
  FLAG_UNKNOWN = 'FEATURE_FLAG_UNKNOWN',
  FLAG_FORBIDDEN = 'FEATURE_FLAG_FORBIDDEN',
  FLAG_STORE_UNAVAILABLE = 'FEATURE_FLAG_STORE_UNAVAILABLE',
  FLAG_CONFLICT = 'FEATURE_FLAG_CONFLICT',
}
```

Evaluation entrypoints:

- `evaluate(name: FeatureFlagName, ctx: { correlationId: string }): FeatureFlagEvaluation`
  returns `{ name, enabled, source, correlationId }`.
- `evaluateAll(ctx)` returns a map of every known flag with the same envelope.
- `setFlag(name, enabled, ctx)` mutates a flag and returns the new evaluation.

Every response carries the caller-supplied `correlationId` (or a generated one) so
logs, metrics, and error envelopes can be joined end-to-end.

## Authorization (Deny-by-Default)

All privileged flag surfaces are deny-by-default. A caller must present **one** of
the following, and the role is checked against the flag's policy:

| Principal        | Allowed operations                          |
|------------------|---------------------------------------------|
| `owner`          | read + mutate all flags                     |
| `delegate`       | read + mutate flags explicitly delegated    |
| `guardian`       | read all; mutate only safety/kill-switch    |
| `api-key`        | read only, scoped to the key's flag set     |
| `jwt`            | read only, scoped to the subject's claims   |

Requests that fail authz return `FLAG_FORBIDDEN` with the correlation id — never a
silent default. Revoked delegates and expired JWTs are rejected before evaluation.

## Fail-Closed Behaviour

- **Unknown or missing flag** → treated as **disabled** for money-path behaviour
  (`PAYMENTS`, `MAINNET_PAYMENTS`, `KEY_MANAGEMENT`). The API returns 503 rather
  than proceeding.
- **Store outage (DB/RPC/Horizon)** → writes fail closed with
  `FLAG_STORE_UNAVAILABLE`; reads fall back to the last known-good snapshot and
  are marked `source: 'snapshot'` in the evaluation envelope.
- **Testnet vs mainnet misconfig** → `MAINNET_PAYMENTS` is only honoured when the
  network is mainnet; on testnet it is forced off and logged.

## Idempotency

Flag mutations accept an `Idempotency-Key` header. Replayed or concurrent
requests with the same key return the original result and never double-apply.
Conflicting payloads for the same key return `FLAG_CONFLICT`.

## Observability

- Metrics: `feature_flag_evaluations_total{name,enabled,source}` and
  `feature_flag_mutations_total{name,result}`.
- Logs include `correlationId`, flag name, and decision — never raw key material,
  JWTs, or webhook secrets.
- Errors use the shared error envelope with the stable codes above.

## Rollback / Kill-Switch

Every money-path or mainnet-affecting change lands behind its `FEATURE_*` flag.
To roll back, set the flag to `false` and redeploy; the API fails closed and no
further writes are accepted. Document the flag and rollback step in the PR
description for any change touching payments, key management, or mainnet.

## Security Notes

- `getAll()` returns only boolean flag states — it never contains secrets.
- Flag state is logged at startup without exposing `WALLET_ENCRYPTION_KEY`, API keys, or seeds.
- Disabling a flag prevents the API from operating; it does not create a fail-open path.
- The server remains the source of truth for spends, recovery, and admin actions;
  clients cannot bypass policy by spoofing flag state.
