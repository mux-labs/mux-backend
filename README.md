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

## Error Handling

All API endpoints return structured error responses in a consistent format for better client-side error handling and debugging.

### Error Response Format

```json
{
  "statusCode": 404,
  "timestamp": "2026-05-30T12:00:00.000Z",
  "path": "/api/wallets/invalid-id",
  "method": "GET",
  "message": "Wallet not found",
  "error": "Not Found",
  "requestId": "req-123-456"
}
```

### Error Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `statusCode` | number | HTTP status code (400, 404, 500, etc.) |
| `timestamp` | string | ISO 8601 timestamp when the error occurred |
| `path` | string | Request path that caused the error |
| `method` | string | HTTP method (GET, POST, PUT, DELETE, etc.) |
| `message` | string \| string[] | Human-readable error message(s) |
| `error` | string | Error type/name (e.g., "Not Found", "Bad Request") |
| `details` | object | Optional additional error details (validation errors, etc.) |
| `requestId` | string | Optional request ID for tracing (from `x-request-id` header) |

### Common HTTP Status Codes

| Status Code | Error Type | Description |
|-------------|------------|-------------|
| 400 | Bad Request | Invalid request parameters or body |
| 401 | Unauthorized | Missing or invalid authentication |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Resource conflict (e.g., duplicate entry) |
| 422 | Unprocessable Entity | Validation errors |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |
| 503 | Service Unavailable | Service temporarily unavailable |

### Validation Errors

Validation errors return a 400 or 422 status with an array of error messages:

```json
{
  "statusCode": 400,
  "timestamp": "2026-05-30T12:00:00.000Z",
  "path": "/api/wallets",
  "method": "POST",
  "message": [
    "network must be either MAINNET or TESTNET",
    "userId must be a valid UUID"
  ],
  "error": "Bad Request"
}
```

### Error Details

Some errors include additional context in the `details` field:

```json
{
  "statusCode": 422,
  "timestamp": "2026-05-30T12:00:00.000Z",
  "path": "/api/users",
  "method": "POST",
  "message": "Validation failed",
  "error": "Unprocessable Entity",
  "details": {
    "field": "email",
    "constraint": "isEmail",
    "value": "invalid-email"
  }
}
```

### Security Considerations

- **No stack traces**: Stack traces are never exposed in production
- **Sanitized messages**: Sensitive data (passwords, API keys, database URLs) are automatically sanitized
- **No internal paths**: File paths and internal implementation details are hidden
- **Request tracing**: Use the `x-request-id` header for distributed tracing

### Client Integration

When integrating with the API, always check the `statusCode` field and handle errors appropriately:

```typescript
try {
  const response = await fetch('/api/wallets/123');
  const data = await response.json();
  
  if (!response.ok) {
    // Handle structured error
    console.error(`Error ${data.statusCode}: ${data.message}`);
    console.error(`Path: ${data.path}, Method: ${data.method}`);
    
    if (data.details) {
      console.error('Details:', data.details);
    }
  }
} catch (error) {
  console.error('Network error:', error);
}
```

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
