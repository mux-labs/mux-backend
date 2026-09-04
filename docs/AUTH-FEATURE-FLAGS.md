# Auth Feature Flags

This document summarizes feature flags added for the auth and session endpoints.

- `FEATURE_AUTH_API` (boolean, default: false)
  - When `true`, the auth endpoints are enabled: `POST /auth/authenticate`, `GET /auth/sessions`, `GET /auth/validate/:authId`.
  - When `false` or unset, the endpoints return HTTP 403 (Forbidden) with message: "Feature is not available at this time. (Flag: auth_api)".

## Endpoint Authentication & Authorization Policies

### `POST /auth/authenticate`
- **Access**: Public (no auth required, feature flag gates availability)
- **Requirements**: Must provide valid, signed JWT token in Authorization header
- **Scoping**: Identity is cryptographically verified from JWT; not user-scoped (enables new user onboarding)

### `GET /auth/sessions`
- **Access**: Authenticated (requires valid JWT token)
- **Scoping**: Self-scoped to authenticated user's sessions only. Callers cannot list another user's sessions.
- **Enforcement**: Must verify authenticated user ID and scope results to that user

### `GET /auth/validate/:authId`
- **Access**: Public (no auth required, rate-limited)
- **Purpose**: Pre-flight check to see if an authId can authenticate (returns 200/401/403)
- **Scoping**: Not user-scoped (allows UX validation without requiring auth)

## Implementation Notes

- The flag is implemented via the existing `FeatureFlagGuard` and the `@FeatureFlag('auth_api')` decorator on the `AuthOrchestratorController`.
- The guard reads environment variables using the existing pattern: `FEATURE_<FLAG_NAME>=true|false` (e.g. `FEATURE_AUTH_API=true`).
- `GET /auth/sessions` is NOT marked `@Public()` and therefore requires authentication beyond the feature flag.
- Existing unit tests for `FeatureFlagGuard` cover enabled/disabled behavior. The auth controller tests override the guard for isolation.

## Operational Guidance

- To enable auth in runtime, set `FEATURE_AUTH_API=true` in the configuration used by the service (env, k8s secret, etc.).
- Ensure any API gateway or routing changes are coordinated when toggling this flag in production to avoid unexpected client errors.
- For `GET /auth/sessions`, ensure the backend can extract the authenticated user's ID from the verified JWT and scope queries accordingly.
