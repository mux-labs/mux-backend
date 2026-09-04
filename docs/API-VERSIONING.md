# API Versioning Strategy

This document describes how the Mux backend versions its public HTTP API.

## Current approach: URI path versioning

All routes are served under a global `/v1` prefix, applied once in `src/main.ts`:

```ts
app.setGlobalPrefix('v1');
```

Individual controllers (e.g. `@Controller('auth')`, `@Controller('wallets')`)
declare their resource path only; the version prefix is applied globally so
every route is automatically namespaced (`/v1/auth/authenticate`,
`/v1/wallets`, etc.). Requests made without the `/v1` prefix return `404 Not
Found` — there is no unversioned fallback.

## Why URI versioning

- **Explicit and cache-friendly**: the version is visible in the URL, in logs,
  and in reverse-proxy/CDN routing rules, without relying on a header that
  intermediaries may strip.
- **Simple for consumers**: partners and the frontend hard-code a base URL
  (e.g. `https://api.mux.dev/v1`) rather than needing to set a custom header
  on every request.
- **Matches existing NestJS conventions** in this repo — a single
  `setGlobalPrefix` call versions every controller without per-route
  decorators.

## Introducing a breaking change (`/v2`)

When a change is not backwards compatible:

1. Add the new/changed controllers under a `v2` path (NestJS's built-in
   [URI versioning](https://docs.nestjs.com/techniques/versioning) via
   `app.enableVersioning({ type: VersioningType.URI })` can be adopted at that
   point to run `v1` and `v2` controllers side by side).
2. Keep `/v1` serving the previous behavior until consumers have migrated.
3. Announce the deprecation window for `/v1` in release notes before removal.

## Non-breaking changes

Additive changes (new endpoints, new optional request/response fields) ship
directly under the current `/v1` prefix — no new version is required.

## Health and monitoring endpoints

`/v1/health` and `/v1/ready` follow the same prefix as every other route, so
uptime checks and readiness probes must be configured with the `/v1` path.
