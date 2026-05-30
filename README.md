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

## Security Model (MVP)

* Private keys are never exposed to clients
* Keys are encrypted at rest
* All blockchain transactions are signed server-side
* Fees are sponsored by the platform
* Auth provider is the source of truth for identity

> ⚠️ This MVP uses a custodial model. Progressive decentralization is planned.

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
