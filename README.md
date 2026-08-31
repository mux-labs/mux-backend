# Mux Backend

Backend infrastructure for **Mux Protocol** — powering invisible wallets, payment orchestration, and smart contract interaction on **Stellar (Soroban)**.

Mux Backend abstracts blockchain complexity behind a secure, Web2-friendly API, enabling users to interact with crypto without managing keys, gas, or wallets directly.

---

## Overview

Mux Backend is the trusted coordination layer between:

* Web2 authentication providers (Clerk / Better Auth) — verified via cryptographic JWT validation
* Stellar accounts and Soroban smart contracts
* Frontend clients and SDKs

It handles wallet creation, transaction orchestration, fee sponsorship, and on-chain/off-chain state reconciliation.

**Critical security invariant**: User identity is established only through cryptographic verification of JWT tokens from the configured identity provider. Tokens are verified at every authentication request. Local user status (ACTIVE/INACTIVE/SUSPENDED) is checked and enforced on every call. No client-supplied identity claims are trusted.

---

## Core Responsibilities

* **Cryptographic identity verification**: Verify all user identity claims via signed JWT tokens from the configured identity provider (Clerk or Better Auth). No client-supplied identity is trusted.
* **User status enforcement**: Enforce local user status checks (ACTIVE/INACTIVE/SUSPENDED) on every authentication request, rejecting disabled or suspended accounts.
* Invisible wallet creation and management
* Secure custody and encryption of Stellar keypairs
* Transaction relaying and fee sponsorship
* Soroban smart contract invocation
* Spending limit and policy enforcement
* Indexing and caching on-chain data
* Serving APIs to frontend applications
* Health monitoring and readiness checks

---

## API Endpoints

All routes below are served under the `/v1` prefix (e.g. `GET /v1/health`). See [docs/API-VERSIONING.md](docs/API-VERSIONING.md) for the versioning strategy.

### Error responses

Every error — thrown `HttpException`, unhandled exception, or validation
failure — is returned by a global exception filter in the same structured
envelope:

```json
{
  "statusCode": 422,
  "timestamp": "2026-07-30T12:34:56.789Z",
  "path": "/v1/wallets/123/limits",
  "method": "POST",
  "message": "Per-transaction limit exceeded. Limit: 1000",
  "error": "Unprocessable Entity",
  "errorCode": "LIMIT_PER_TX_EXCEEDED",
  "requestId": "..."
}
```

`error` and `message` are always present. `errorCode` (a stable, machine-readable
string) and `details` (a structured object) are included only when the thrown
exception provides them. `requestId` is echoed back from the `X-Request-ID`
request header when present. In production, `message` on unhandled 500 errors
is sanitized to strip connection strings, file paths, and secrets.

### Request body size

JSON and URL-encoded request bodies are limited to 100 KiB by default. Set
`JSON_BODY_LIMIT_BYTES` to a value from 1 byte through 10 MiB to change the
limit. Requests over the configured limit return `413 Payload Too Large`:

```json
{
  "statusCode": 413,
  "error": "Payload Too Large",
  "message": "Request body exceeds the maximum allowed size"
}
```

### Maintenance mode

Maintenance mode is persisted in PostgreSQL and shared by every API instance.
While enabled, `POST`, `PUT`, `PATCH`, and `DELETE` routes return `503 Service
Unavailable`; `GET`, `HEAD`, and `OPTIONS` remain available. A configured retry
delay is returned in the `Retry-After` header.

Inspect the current maintenance status with `GET /v1/maintenance` (public endpoint, no authentication required). To change the state,
send `PATCH /v1/maintenance` with normal API-key authentication plus the
`X-Maintenance-Secret` header matching `MAINTENANCE_ADMIN_SECRET`. This secret
is required in production — startup fails fast if it is unset.

```json
{
  "enabled": true,
  "message": "Scheduled ledger maintenance",
  "retryAfterSeconds": 300
}
```

The maintenance endpoint itself remains available while maintenance mode is on
so an authorized operator can disable it. If the persisted state cannot be read,
mutating requests fail closed with `503 Service Unavailable`.

### Health & Monitoring

#### `GET /health`

Liveness probe endpoint for Kubernetes and container orchestration platforms.

**Purpose**: Indicates whether the application process is alive and responsive. This is a lightweight check that does NOT verify external dependencies like databases.
#### `GET /ready`

Readiness probe endpoint for Kubernetes and container orchestration platforms.

**Purpose**: Indicates whether the application is ready to serve traffic by verifying database connectivity.

**Response (200 OK)**:
```json
{
  "status": "ready",
  "timestamp": "2026-05-30T12:00:00.000Z",
  "database": {
    "connected": true,
    "responseTime": 15
  }
}
```

**Response (503 Service Unavailable)**: Returned when the database is not accessible.

**Use Cases**:
- Kubernetes readiness probes
- Load balancer health checks
- Container orchestration platforms
- CI/CD deployment verification

**Authentication**: Public endpoint (no API key required)

---

## API Endpoints

### Authentication

#### `POST /auth/authenticate`

Main authentication endpoint for user onboarding and wallet creation with cryptographic identity verification.

**Purpose**: Handles both first-time and returning users. Verifies the caller's identity via signed JWT token, creates user and wallet if needed, returns existing data if already exists. All operations are idempotent.

**Authentication**: **Public endpoint** (no API key required) — This must be public as it's used for initial authentication before an API key is available. However, a **valid, signed JWT token** from the configured identity provider (Clerk or Better Auth) is **required** in the Authorization header.

**Identity Verification**:
- The Authorization header must contain a bearer token (JWT) from the configured identity provider.
- The backend verifies the token signature cryptographically against the provider's keys.
- User identity (authId, authProvider) is extracted **only** from the verified token claims.
- Any authId or authProvider supplied in the request body are ignored; identity always comes from the verified JWT.
- Suspended or inactive accounts (status != ACTIVE) are rejected.

**Request Headers**:
```
Authorization: Bearer <jwt_token_from_clerk_or_better_auth>
```

**Request Body** (only email, displayName, and network are used; authId/authProvider come from JWT):
```json
{
  "email": "user@example.com",
  "displayName": "User Name",
  "network": "TESTNET"
}
```

**Response (200 OK)**:
```json
{
  "user": {
    "id": "uuid",
    "authId": "verified-from-jwt-sub-claim",
    "email": "user@example.com",
    "displayName": "User Name",
    "status": "ACTIVE",
    "authProvider": "verified-from-jwt-auth-provider-claim",
    "lastLoginAt": "2026-05-30T12:00:00.000Z"
  },
  "wallet": {
    "id": "uuid",
    "publicKey": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "network": "TESTNET",
    "status": "ACTIVE",
    "createdAt": "2026-05-30T12:00:00.000Z"
  },
  "refreshToken": "hex-encoded-token",
  "isNewUser": false,
  "isNewWallet": false
}
```

**Response (401 Unauthorized)**:
- Returned if Authorization header is missing or token verification fails.

**Response (403 Forbidden)**:
- Returned if the verified user has INACTIVE or SUSPENDED status.

**Use Cases**:
- Initial user authentication and onboarding
- Automatic wallet creation for new users
- Idempotent user/wallet retrieval for returning users
- Integration with Web2 auth providers (Clerk, Better Auth, etc.)
- Safe account suspension/deactivation enforcement

---

## Authentication & Trust Model

Mux Backend uses a **server-side verification only** trust model for user authentication. This is critical given that the backend custodies Stellar private keys and relays sponsored transactions.

### What is Verified

1. **JWT Signature**: Every authentication request requires a signed JWT token from the configured identity provider (Clerk or Better Auth). The backend cryptographically verifies the token signature using the provider's public keys. Tampered, forged, or unsigned tokens are rejected.

2. **Token Claims**: The verified token must contain:
   - `sub` (subject): The user's unique identifier in the identity provider system. This becomes the `authId` in Mux Backend.
   - `auth_provider`: The identity provider name (CLERK, BETTER_AUTH, etc.). This becomes the `authProvider`.

3. **User Status**: After identity is verified from the JWT, the backend checks the local user record's status field. Users with status `INACTIVE` or `SUSPENDED` are rejected, even if their JWT is valid. This allows operators to disable compromised or abusive accounts immediately.

### What is NOT Trusted

- **Client-supplied identity fields**: Any authId or authProvider values supplied in the request body are ignored. Identity always comes from the verified JWT token. This prevents attacks where a malicious client impersonates another user.
- **Email or display name**: These are optional metadata fields that are validated but not used for identity. A user's identity is established solely through the verified JWT `sub` claim.
- **Provider profile fields**: Data relayed from the identity provider (e.g., the user's email stored in Clerk) is not used for access control. Local status is the authoritative source.

### Production Safety

In production (`NODE_ENV=production`):
- If JWT verification is unavailable (library not installed, configuration missing), the application fails to start or requests fail with 503 Service Unavailable. There is no silent fallback to trusting client-supplied identity.
- Identity provider configuration (e.g., `CLERK_JWT_PUBLIC_KEY` or `BETTER_AUTH_JWKS_URL`) is required and validated at startup.

### Development & Testing

For local development without live provider credentials, set `AUTH_SKIP_JWT_VERIFICATION=true` and use dev-mode stub tokens in format: `dev-<provider>-<userid>` (e.g., `dev-clerk-user123`). This mode is structurally impossible to enable in production and is clearly marked as development-only in code.

---

## User Lifecycle

Users go through the following lifecycle:

1. **Onboarding**: User presents a valid JWT token to `POST /auth/authenticate`. If new, a user record and wallet are created. Status is set to `ACTIVE`.

2. **Active**: User can authenticate and use all API endpoints. Every request verifies their JWT token and checks they remain `ACTIVE`.

3. **Suspended** (operator-initiated): Operator updates the user's status to `SUSPENDED` via internal admin tools or database. Subsequent authentication attempts fail with 403 Forbidden, even though the user's JWT may still be valid. The user cannot authenticate or access any endpoints.

4. **Inactive** (similar to suspended): User status can be set to `INACTIVE` for other reasons (e.g., terms violation, dormant account cleanup). Behaves identically to `SUSPENDED` — authentication is rejected.

Users cannot be "deleted" through normal API flows; instead, their status is changed to reflect they should not authenticate. This preserves audit trails and on-chain transaction history.

---

## Key Features

### 🔐 Invisible Wallets

* Automatic Stellar account creation on user signup
* No seed phrases or wallet prompts
* Keys encrypted and stored securely server-side

### 🔁 Transaction Orchestration

Payment creation validates the UUID wallet identities, creates the modern
transaction record, signs with the sender wallet custody key, and submits the
envelope to Horizon. Legacy `fromId`, `toId`, and `userId` payment fields are
optional compatibility fields during migration. Recovery administration
requires `X-Recovery-Admin-Secret` and `X-Admin-ID`; production requires
`RECOVERY_ADMIN_SECRET` (at least 32 characters).

* Backend-signed and sponsored transactions
* Internal user-to-user transfers
* Support for batching and relaying

### 🧠 Account Abstraction Layer

* User identity mapped to blockchain accounts
* Programmable spending limits
* Recovery and key rotation flows

### 📦 Smart Contract Integration

* Soroban contract interaction
* Wallet registry and policy enforcement contracts
* Future support for smart wallet accounts

### 📊 Indexing & Caching

* Track balances and transactions
* Human-readable transaction history
* Cached reads for fast UX

---

## Database Setup

This project uses **PostgreSQL** via **Prisma ORM**. You must set the `DATABASE_URL` environment variable before running migrations or starting the server.

### Environment Variables

Copy `.env.example` to `.env` (or create `.env`) and set:

```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?schema=public"
WALLET_ENCRYPTION_KEY="your-secure-encryption-key-min-32-chars-long"
EXPORT_SIGNING_SECRET="your-secure-export-signing-secret-min-32-chars-long"
WEBHOOK_SIGNING_KEY="your-secure-webhook-signing-key-min-32-chars-long"
```

#### Boot-Time Configuration Validation

To guarantee security, the application validates critical environment variables during startup:

* **`WALLET_ENCRYPTION_KEY`**: Key used to encrypt Stellar wallet private keys.
  - **Required**: Must be defined and not empty.
  - **Length**: Must be at least **32 characters** long.
  - **Security**: Must **not** match the default placeholder string (`your-secret-encryption-key-min-32-chars`).
  - **Behavior**: If validation fails, the application throws an error and fails to boot.
* **`EXPORT_SIGNING_SECRET`**: Secret used to sign export download tokens.
  - **Required in production**: Must be defined and not empty.
  - **Length**: Must be at least **32 characters** long.
  - **Security**: No hardcoded fallback secret is allowed; startup fails closed when it is missing.
* **`WEBHOOK_SIGNING_KEY`**: Master key used to derive outbound webhook signing secrets (only SHA-256 hashes are stored at rest).
  - **Required in production**: Must be defined and not empty.
  - **Length**: Must be at least **32 characters** long.
  - **Security**: No hardcoded fallback or placeholder is allowed; startup fails closed when it is missing. Never log this value.
* **`WEBHOOK_SECRET_GRACE_SECONDS`**: Grace window for `rotate-secret` (default `3600`). During this window deliveries keep being signed with the previous secret so consumers are not cut off.

**Examples:**

| Environment | Connection string |
|---|---|
| Local dev | `postgresql://postgres:postgres@localhost:5432/mux_dev` |
| Docker Compose | `postgresql://postgres:postgres@db:5432/mux_dev` |
| Supabase | `postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres` |
| Railway / Render | Use the connection string provided by the platform |

### Running Migrations

```bash
# Apply all pending migrations (development)
pnpm prisma:migrate

# Apply migrations in production / CI (non-interactive)
pnpm prisma:migrate:prod

# Seed the database with demo users and wallets (dev only)
pnpm prisma:seed

This seed also creates an onboarding developer account and a starter project for developer flows.

A new developer API route is available: `GET /developers/:id/projects` returns the projects belonging to a developer.
```

> The `DATABASE_URL` variable is read at runtime and during migration. Never commit credentials to version control — use environment secrets in CI.

---

## Security Model (MVP)

* Private keys are never exposed to clients
* Keys are encrypted at rest using AES-256-GCM
* All blockchain transactions are signed server-side
* Fees are sponsored by the platform
* Auth provider is the source of truth for identity
* **Centralized key management** via KeyManagementService for consistent security

### Key Management Architecture

Mux Backend uses a consolidated `KeyManagementService` for all cryptographic key operations:

**Key Features:**
- ✅ Single source of truth for key generation
- ✅ Provider abstraction (Stellar, future HSM/KMS support)
- ✅ Automatic audit logging of all key operations
- ✅ Private keys NEVER exposed outside the service boundary
- ✅ Immediate encryption after generation
- ✅ Graceful handling of invalid/disconnected states

**Documentation:**
- [Key Management Module README](src/key-management/README.md)
- [Key Management Consolidation Guide](docs/key-management-consolidation.md)
- [Migration Guide](docs/MIGRATION-KEY-MANAGEMENT.md)

> ⚠️ This MVP uses a custodial model. Progressive decentralization is planned.

---

## Authentication Flow

Mux Backend supports two authentication mechanisms:

### 1. API Key Authentication (Recommended for Backend Services)

API keys are used for server-to-server communication and administrative tasks. Each key is securely hashed before storage.

**Key Characteristics:**
- Format: `mux_live_<random32chars>` or `mux_test_<random32chars>`
- Transmitted via `Authorization: Bearer <key>` header
- Returned only once at creation time
- Hashed with SHA-256 before storage in database
- Can be rotated, revoked, or expire at a configured time

### 2. User Authentication (Primary Identity Flow)

User authentication is orchestrated via the auth service and integrates with Web2 identity providers (Clerk, Better Auth, etc.).

**Authentication Flow Steps:**

1. **Credential Submission**
   - Client sends `authId`, email, displayName, and authProvider to `POST /auth/authenticate`
   - The authId is typically a provider's unique identifier (e.g., Clerk user ID)

2. **User Validation**
   - AuthOrchestrator calls IdempotentUserService to find or create the user
   - User record is created with `status: 'ACTIVE'` by default

3. **Status Check (Inactive User Rejection)**
   - Before proceeding, the system checks the user's `status` field
   - **If status is not `ACTIVE`** (e.g., `INACTIVE`, `SUSPENDED`, `DELETED`), authentication is rejected with `403 Forbidden` and message "Account is inactive"
   - Missing status field defaults to `ACTIVE` for backward compatibility

4. **Wallet Provisioning**
   - If user is active, AuthOrchestrator ensures the user has a wallet on the requested network
   - Wallet is created automatically on first authentication (idempotent)

5. **Response**
   - Returns authenticated user object with ID, status, authProvider
   - Returns wallet object with public key and network
   - Includes `isNewUser` and `isNewWallet` flags for client-side logic

**Authentication Response Example:**
```json
{
  "user": {
    "id": "user-123",
    "authId": "clerk-id-xyz",
    "email": "user@example.com",
    "displayName": "Jane Doe",
    "status": "ACTIVE",
    "authProvider": "CLERK"
  },
  "wallet": {
    "id": "wallet-456",
    "publicKey": "GABC123...",
    "network": "TESTNET",
    "status": "ACTIVE"
  },
  "isNewUser": true,
  "isNewWallet": true
}
```

### API Key Validation & Usage

**Request Flow for API Key Protected Endpoints:**

1. Client sends request with `Authorization: Bearer mux_live_...` header
2. ApiKeyGuard intercepts request and extracts the key
3. Guard delegates to ApiKeyService for validation:
   - Hash the provided key with SHA-256
   - Lookup in database by key hash
   - Check if key is ACTIVE
   - Check if key has not expired
   - Update last_used_at timestamp (async)
4. If valid, attach ApiKeyContext to request (apiKey, project, developer info)
5. If invalid/expired, return `401 Unauthorized`

**Key Expiry Behavior:**
- Expired keys are marked with status `EXPIRED` on first validation attempt
- Subsequent requests with expired keys fail with "API key has expired"

### Rate Limiting & Inactive User Integration

- Rate limits are enforced per API key
- User status is checked during authentication; inactive users cannot authenticate
- Once authenticated, API key usage is tracked independently of user status
- Sensitive endpoints (payments, transactions) apply stricter rate limits

### Environment Variables

Key authentication-related environment variables (when applicable):

- `AUTH_PROVIDER` — Identity provider (e.g., CLERK, BETTER_AUTH)
- `JWT_SECRET` — (Future) JWT signing secret
- `API_KEY_EXPIRY_DAYS` — (Future) Default API key expiry duration in days
- `RATE_LIMIT_RPM` — Requests per minute limit (per API key)

---

## Design Principles

* **Crypto is infrastructure, not UX**
* **Auth-first, wallet-second**
* **Correctness > flexibility**
* **Explicit over magical abstractions**
* **Upgrade paths over rewrites**

---

## Roadmap

* Smart contract wallet accounts (Soroban)
* Session keys and spending limits
* Wallet recovery flows
* Fiat on/off-ramps via Stellar anchors
* Optional self-custody export for advanced users

---

## License

MIT

---

## Contributing

Contributions are welcome. Please open an issue before submitting large changes.

---

Request Logging Middleware

A lightweight request logging middleware has been added to the application to record incoming HTTP requests and response durations. It:

- Sets an `x-request-id` header (honors incoming `x-request-id` if present).
- Logs method, URL, client IP and request id when requests start and when they finish.
- Is robust to stale/invalid request objects and will not crash the application.

The middleware is registered in `src/main.ts` and runs for all incoming requests.

---

## Balance Indexer

The balance indexer provides fast, cached balance reads without hitting Stellar Horizon on every request.

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  BalanceIndexerService                  │
│                                                         │
│  getBalance()          → cached read from DB            │
│  getAllBalances()       → cached reads from DB           │
│  syncWalletBalances()  → fetch Horizon → upsert DB      │
│  reconcileBalance()    → compare DB vs Horizon          │
│  reconcileAllBalances()→ full sweep across active wallets│
│  syncAllWallets()      → manual full sync trigger       │
└──────────┬──────────────────────┬───────────────────────┘
           │                      │
  ┌────────▼────────┐   ┌────────▼──────────────┐
  │  PrismaService  │   │  StellarHorizonService │
  │  (PostgreSQL)   │   │  (Horizon REST API)    │
  └─────────────────┘   └────────────────────────┘
```

### Stale Detection

Balances older than `BALANCE_STALE_THRESHOLD_MS` (default 5 minutes) trigger an async background refresh on the next read. The stale value is still returned immediately so callers are never blocked.

### Mismatch Handling

On reconciliation, if the indexed balance differs from the on-chain balance, the indexed value is corrected and `mismatchDetectedAt` / `reconciliationAttempts` are updated for observability.

### Sync Job Tracking

All sync and reconciliation operations create a `BalanceSyncJob` record for audit and observability.

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/balances/wallet/:walletId` | Get cached balances (add `?assetType=NATIVE` for single asset) |
| `POST` | `/balances/wallet/:walletId/sync` | Manually trigger sync for a single wallet |
| `POST` | `/balances/sync-all` | Manually trigger full sync for all active wallets (admin) |
| `POST` | `/balances/wallet/:walletId/reconcile` | Reconcile wallet balance with on-chain state |
| `POST` | `/balances/reconcile-all` | Reconcile all balances (admin) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BALANCE_STALE_THRESHOLD_MS` | `300000` | Age (ms) after which a balance is considered stale |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Stellar Horizon API URL |

---

## Webhooks

Webhooks allow your application to receive real-time notifications when events occur in Mux Protocol.

### Endpoint CRUD

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/webhooks/endpoints` | Register a new webhook endpoint |
| `GET` | `/webhooks/endpoints/project/:projectId` | List endpoints for a project |
| `GET` | `/webhooks/endpoints/:id` | Get a specific endpoint |
| `PUT` | `/webhooks/endpoints/:id` | Update an endpoint |
| `DELETE` | `/webhooks/endpoints/:id` | Delete an endpoint |
| `POST` | `/webhooks/endpoints/:id/rotate-secret` | Rotate signing secret |
| `GET` | `/webhooks/endpoints/:id/deliveries` | Get delivery history |
| `POST` | `/webhooks/process-deliveries` | Manually process pending deliveries (admin) |

### Payload Signing

All webhook payloads are signed with HMAC-SHA256. The `X-Webhook-Signature` header has format `t=<timestamp>,v1=<signature>`. Verify with the secret returned at endpoint creation.

### Signing Secret Storage & Rotation

* **Hashed at rest**: Signing secrets are **never stored in plaintext**. Each endpoint's secret is derived deterministically from the server-side `WEBHOOK_SIGNING_KEY` (HMAC-SHA256 over endpoint id + version) and only its SHA-256 hash is persisted — exactly like API keys. A database leak exposes only hashes.
* **Returned exactly once**: The plaintext secret is returned only by `POST /webhooks/endpoints` (creation) and `POST /webhooks/endpoints/:id/rotate-secret` (rotation). Store it immediately; it is never returned again.
* **Downtime-free rotation**: `rotate-secret` stages a new secret version. Outbound deliveries keep being signed with the previous (established) secret until the grace window (`WEBHOOK_SECRET_GRACE_SECONDS`, default `3600`s) elapses, then the new secret is promoted automatically on the next dispatch. Consumers still verifying with the old secret are never cut off.
* **Fails closed**: In production the server refuses to boot without `WEBHOOK_SIGNING_KEY`; there is no silent default or mock.

### Supported Events

`wallet.created`, `wallet.activated`, `wallet.suspended`, `wallet.rotated`, `transaction.created`, `transaction.pending`, `transaction.confirmed`, `transaction.failed`, `balance.updated`, `balance.low`, `user.created`, `user.updated`

---

## Wallets API

Endpoint semantics, idempotency, lifecycle events, dependency retries, and
metrics are documented in [docs/WALLET-API.md](docs/WALLET-API.md).

- `POST /wallets` - create wallet
- `GET /wallets` - list all wallets
- `GET /wallets/user/:userId` - list wallets by userId (#189)
- `GET /wallets/:id` - get wallet by id
- `GET /wallets/:id/status` - get wallet status (#185)
- `GET /wallets/address/:publicKey?network=TESTNET` - find wallet by Stellar public key (address uniqueness lookup)
- `PATCH /wallets/:id` - update wallet status
- `PATCH /wallets/:id/activate` - activate wallet (PROVISIONING -> ACTIVE) (#188)
- `DELETE /wallets/:id` - remove wallet

### Wallet Nickname

Wallets can carry a short, optional human-readable label.

- `PATCH /wallets/:id/nickname` - set or clear the wallet nickname

**Request body**:
```json
{ "nickname": "Savings wallet" }
```
Pass `null` (or omit the field) to clear an existing nickname. The label is capped at 100 characters. The `nickname` field is included in all wallet responses.

### Orchestration Endpoints

- `POST /wallets/orchestration/create` - creates wallet with PROVISIONING -> ACTIVE flow, funds testnet account on TESTNET (#187, #188)
- `GET /wallets/orchestration/user/:userId/:network` - get wallet by user and network
- `GET /wallets/orchestration/validate/:userId/:network` - validate user can create wallet

Protected endpoint:

- `GET /wallets/protected` - requires a valid API key. Supply API key in `Authorization` header as `ApiKey <key>` or `Bearer <key>`.
- When a valid key is provided, the route returns a JSON object with `message`, `developer`, and `project` fields.

### Wallet Creation Flow (#187, #188)

When a wallet is created via the orchestration endpoint:

1. Wallet is created with `PROVISIONING` status
2. If the network is `TESTNET`, the account is automatically funded via Stellar Friendbot (non-blocking on failure)
3. Wallet status transitions to `ACTIVE`

The individual `GET /wallets/:id/status` endpoint provides a lightweight status check without exposing encrypted secrets.

Authentication and error behavior

- API keys are validated by `ApiKeyGuard` and `ApiKeyService`.
- Missing or invalid API keys return `401 Unauthorized`.
- Upstream validation errors (DB connectivity, etc.) surface as `401` if they originate from `ApiKeyService` throwing `UnauthorizedException`; other unexpected errors may surface as 5xx.

Testing

- Unit tests are under `src/**/*spec.ts`.
- E2E tests are under `test/` and use Jest + Supertest.

---

## Transactions API

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/transactions` | Create a transaction (PENDING state) |
| `GET` | `/transactions` | List transactions with filters and pagination (#497) |
| `GET` | `/transactions/:id` | Get a transaction by ID |
| `GET` | `/transactions/wallet/:walletId` | List transactions for a wallet |
| `GET` | `/transactions/stellar/:hash` | Find a transaction by Stellar hash |
| `PATCH` | `/transactions/:id/status` | Update transaction status |
| `POST` | `/transactions/build` | Build an unsigned Stellar transaction XDR |
| `POST` | `/transactions/fee-bump` | Wrap an inner signed transaction with a fee-bump envelope and submit to Stellar |

### Filtering Transactions (#497)

`GET /transactions` accepts the following query parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `senderWalletId` | string | Filter by sender wallet ID |
| `receiverWalletId` | string | Filter by receiver wallet ID |
| `status` | enum | Filter by status: `PENDING`, `SUBMITTED`, `CONFIRMED`, `FAILED` |
| `assetType` | string | Filter by asset type (e.g. `NATIVE`, `CREDIT_ALPHANUM4`) |
| `assetCode` | string | Filter by asset code (e.g. `USDC`) |
| `minAmount` | string | Minimum amount, inclusive |
| `maxAmount` | string | Maximum amount, inclusive |
| `createdAfter` | ISO 8601 | Return transactions created on or after this timestamp |
| `createdBefore` | ISO 8601 | Return transactions created on or before this timestamp |
| `memo` | string | Case-insensitive substring search on memo field |
| `limit` | number | Max records to return (1–100, default 20) |
| `offset` | number | Records to skip for pagination (default 0) |

Results are ordered newest-first. The response envelope includes `data`, `total`, `limit`, `offset`, and `hasMore`.

### Transaction Status Lifecycle (#498)

Internal transaction statuses and their Horizon result mappings:

| Status | Description | Horizon mapping |
|--------|-------------|-----------------|
| `PENDING` | Created, not yet submitted | — |
| `SUBMITTED` | Submitted to Stellar, awaiting ledger inclusion | HTTP 202, `result_code: tx_queued` |
| `CONFIRMED` | Included in a ledger | `successful: true`, `result_code: tx_success` / `tx_fee_bump_inner_success` |
| `FAILED` | Rejected or expired | `successful: false`, any other `result_code` |

`mapHorizonResultToStatus()` in `src/transactions/horizon-result.mapper.ts` performs the mapping. Priority order:

1. HTTP 202 → `SUBMITTED` (Horizon accepted, not yet ledger-confirmed)
2. `successful: true` → `CONFIRMED`
3. `result_code` switch (see mapper for full list)
4. Default → `FAILED`

### Wallet Create Rollback (#494)

`WalletsService.createWallet()` and `WalletCreationOrchestrator.createWallet()` use a two-phase write inside a Prisma transaction:

1. Wallet is inserted with status `PROVISIONING`.
2. Status is transitioned to `ACTIVE` within the same transaction.

If key generation, DB persistence, or activation throws, the Prisma transaction rolls back automatically — no partial wallet record is left in the database. Stale `PROVISIONING` wallets (from crashed processes) are cleaned up via `cleanupStaleProvisioningWallets()`.

Testnet Friendbot funding is performed outside the transaction and is non-blocking; a Friendbot failure does not roll back the wallet.

### Wallet List Pagination (#496)

`GET /wallets` returns a paginated envelope:

```json
{
  "data": [...],
  "total": 42,
  "limit": 20,
  "offset": 0,
  "hasMore": true
}
```

Query parameters: `userId`, `network`, `status`, `includeArchived` (default `false`), `limit` (max 100, default 20), `offset` (default 0). Archived wallets are excluded by default; pass `includeArchived=true` to include them. `encryptedSecret` is never present in list responses.