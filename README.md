# Mux Backend

Backend infrastructure for **Mux Protocol** — powering invisible wallets, payment orchestration, and smart contract interaction on **Stellar (Soroban)**.

Mux Backend abstracts blockchain complexity behind a secure, Web2-friendly API, enabling users to interact with crypto without managing keys, gas, or wallets directly.

---

## Overview

Mux Backend is the trusted coordination layer between:

* Web2 authentication providers (Clerk / Better Auth)
* Stellar accounts and Soroban smart contracts
* Frontend clients and SDKs

It handles wallet creation, transaction orchestration, fee sponsorship, and on-chain/off-chain state reconciliation.

---

## Core Responsibilities

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

Main authentication endpoint for user onboarding and wallet creation.

**Purpose**: Handles both first-time and returning users. Creates user and wallet if needed, returns existing data if already exists. All operations are idempotent.

**Authentication**: **Public endpoint** (no API key required) - This must be public as it's used for initial authentication before an API key is available.

**Request Body**:
```json
{
  "authId": "auth-provider-user-id",
  "email": "user@example.com",
  "displayName": "User Name",
  "authProvider": "CLERK",
  "network": "TESTNET"
}
```

**Response (200 OK)**:
```json
{
  "user": {
    "id": "uuid",
    "authId": "auth-provider-user-id",
    "email": "user@example.com",
    "displayName": "User Name",
    "status": "ACTIVE",
    "authProvider": "CLERK",
    "createdAt": "2026-05-30T12:00:00.000Z",
    "updatedAt": "2026-05-30T12:00:00.000Z"
  },
  "wallet": {
    "id": "uuid",
    "userId": "uuid",
    "publicKey": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "network": "TESTNET",
    "status": "ACTIVE",
    "createdAt": "2026-05-30T12:00:00.000Z",
    "updatedAt": "2026-05-30T12:00:00.000Z"
  },
  "isNewUser": false,
  "isNewWallet": false
}
```

**Use Cases**:
- Initial user authentication and onboarding
- Automatic wallet creation for new users
- Idempotent user/wallet retrieval for returning users
- Integration with Web2 auth providers (Clerk, Better Auth, etc.)

---

## Key Features

### 🔐 Invisible Wallets

* Automatic Stellar account creation on user signup
* No seed phrases or wallet prompts
* Keys encrypted and stored securely server-side

### 🔁 Transaction Orchestration

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
```

#### Boot-Time Configuration Validation

To guarantee security, the application validates critical environment variables during startup:

* **`WALLET_ENCRYPTION_KEY`**: Key used to encrypt Stellar wallet private keys.
  - **Required**: Must be defined and not empty.
  - **Length**: Must be at least **32 characters** long.
  - **Security**: Must **not** match the default placeholder string (`your-secret-encryption-key-min-32-chars`).
  - **Behavior**: If validation fails, the application throws an error and fails to boot.

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

### Supported Events

`wallet.created`, `wallet.activated`, `wallet.suspended`, `wallet.rotated`, `transaction.created`, `transaction.pending`, `transaction.confirmed`, `transaction.failed`, `balance.updated`, `balance.low`, `user.created`, `user.updated`

---

## Wallets API

- `POST /wallets` - create wallet
- `GET /wallets` - list all wallets
- `GET /wallets/user/:userId` - list wallets by userId (#189)
- `GET /wallets/:id` - get wallet by id
- `GET /wallets/:id/status` - get wallet status (#185)
- `PATCH /wallets/:id` - update wallet status
- `PATCH /wallets/:id/activate` - activate wallet (PROVISIONING -> ACTIVE) (#188)
- `DELETE /wallets/:id` - remove wallet

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

