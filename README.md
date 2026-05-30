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

## Security Model (MVP)

* Private keys are never exposed to clients
* Keys are encrypted at rest
* All blockchain transactions are signed server-side
* Fees are sponsored by the platform
* Auth provider is the source of truth for identity

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
