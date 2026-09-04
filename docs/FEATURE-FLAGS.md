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

## Security Notes

- `getAll()` returns only boolean flag states — it never contains secrets.
- Flag state is logged at startup without exposing `WALLET_ENCRYPTION_KEY`, API keys, or seeds.
- Disabling a flag prevents the API from operating; it does not create a fail-open path.
