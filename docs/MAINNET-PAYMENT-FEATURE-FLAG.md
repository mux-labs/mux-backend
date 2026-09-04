# Mainnet Payment Submit Feature Flag

- `FEATURE_MAINNET_PAYMENT_SUBMIT` (boolean, default: false)
  - When `true`, `POST /transactions/fee-bump` requests with `network: "MAINNET"` are submitted to Horizon mainnet as normal.
  - When `false` or unset, MAINNET submissions are rejected with HTTP 403 (Forbidden) and message: "Mainnet payment submission is not available at this time. (Flag: mainnet_payment_submit)". `TESTNET` submissions are unaffected — the flag is only consulted when `network === "MAINNET"`.

Notes:
- Implemented as a kill-switch check inside `FeeBumpService.submitFeeBump` (not the route-level `FeatureFlagGuard`), because the decision depends on the `network` field in the request body rather than being fixed per-route.
- Reuses the existing `FeatureFlagService.isEnabled()` helper and the `FEATURE_<FLAG_NAME>` env var convention (e.g. `FEATURE_MAINNET_PAYMENT_SUBMIT=true`).
- Rejections happen before any wallet key material is decrypted or any call to Horizon is made.

Operational guidance:
- Keep this flag off in production until mainnet payment submission has been reviewed and approved for general availability; flip it on per-environment via env/secret config.
