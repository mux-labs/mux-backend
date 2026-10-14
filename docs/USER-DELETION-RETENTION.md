# User Deletion vs. Data Retention Policy & Architecture

This document defines the architecture, privacy invariants, and compliance boundaries governing user account deletion and data retention in `mux-backend` (#968). It serves as the authoritative reference for Stellar Wave contributors, security reviewers, and compliance auditors.

> Scope: User identity lifecycle, privacy rights (GDPR/CCPA "Right to be Forgotten"), on-chain ledger immutability on Stellar/Soroban, and statutory financial record retention (AML/KYC/CFT).

---

## 1. Overview & Core Invariants

Mux Protocol provides account abstraction and invisible wallets on the Stellar and Soroban networks. When a user requests account deletion via `DELETE /v1/users/:id`, `mux-backend` balances two fundamental requirements:

1. **User Privacy & Account Termination**: Revoking access, disabling credentials, terminating active sessions, and removing non-essential PII.
2. **Financial Compliance & Blockchain Immutability**: Preserving required financial audit records for anti-money laundering (AML) / counter-terrorist financing (CFT) statutory periods and recognizing the cryptographic immutability of public blockchain ledgers.

### System Invariants (Asserted in `test/user-deletion.e2e-spec.ts`)

| Invariant | Description | Enforcement |
| :--- | :--- | :--- |
| **Deny-by-default** | Anonymous requests are rejected immediately; deletion requires API key authentication. | Missing or invalid API key returns `401 Unauthorized`. |
| **Idempotency** | Replaying the same request or repeating deletion against an already soft-deleted user yields the same terminal state. | Returns the soft-deleted user record without repeating destructive operations. |
| **Fail-closed** | Database or dependency outages surface a stable error and never falsely report success. | Returns `500`/`503` when database queries fail; `deletedAt` is never returned on failure. |
| **Secret Non-Leakage** | Responses never leak raw key material, JWTs, API keys, or webhook secrets. | Sanitization redacts PII (`lastLoginIp`, `lastLoginUserAgent`) and prevents secret exposure. |
| **Correlation Tracking** | Every deletion request echoes or generates a correlation ID via `X-Request-ID`. | Response header `X-Request-ID` is guaranteed. |

---

## 2. Deletion vs. Retention Boundaries

The boundary between what is immediately purged/disabled and what is retained is strictly partitioned:

```
+-----------------------------------------------------------------------------------+
|                              USER DELETION BOUNDARY                               |
+----------------------------------------+------------------------------------------+
|  IMMEDIATELY TERMINATED / SOFT-DELETED |       RETAINED FOR AUDIT & COMPLIANCE    |
+----------------------------------------+------------------------------------------+
| - Account status -> DISABLED           | - On-chain Stellar/Soroban transactions  |
| - deletedAt timestamp recorded         | - Cryptographic signature ledger records |
| - Active sessions & tokens revoked     | - AML/KYC financial transaction logs     |
| - Developer API keys disabled          | - Fee sponsorship audit records          |
| - PII access redacted from API layer   | - Idempotency replay protection keys     |
+----------------------------------------+------------------------------------------+
```

### What is Deleted / Terminated Immediately

- **Account Lifecycle State**: The user's status is permanently transitioned to `UserStatus.DISABLED`, and `deletedAt` is set to the current UTC timestamp.
- **Access Revocation**: All active refresh tokens, sessions, and bearer authorizations associated with the user are invalidated.
- **Developer Assets**: Developer projects and API keys associated with the account are disabled to prevent further operations.
- **PII Scrubbing**: Network addresses (`lastLoginIp`) and client user agents (`lastLoginUserAgent`) are excluded from API representations and queued for data scrubbing.

### What is Retained (Compliance & Immutability)

- **Blockchain Ledger Immutability**: Stellar and Soroban blockchain ledgers are cryptographically secured, decentralized, and append-only. Transactions submitted to Horizon or Soroban RPC (payments, trustline changes, contract invocations) cannot be altered, rolled back, or deleted by `mux-backend`.
- **Financial Regulatory Compliance (AML/CFT & FinCEN)**: Under Bank Secrecy Act (BSA) and international AML/CFT regulations, financial service operators must retain transaction histories, counterparty identities, and payment records for a statutory period (typically 5 to 7 years) to support regulatory inquiries and fraud investigations.
- **Idempotency Keys & Deduplication**: To prevent double-spend attacks, transaction replaying, or spoofed re-registration of unconfirmed states, historical idempotency keys and transactional audit journals remain in read-only storage until their defined TTL expires.

---

## 3. API Specification

### `DELETE /v1/users/:id`

Soft-deletes an existing user account.

#### Headers

- `Authorization: ApiKey <key>` (Required): API key with appropriate administrative or tenant permissions.
- `X-Request-ID: <string>` (Optional): Correlation ID. If omitted, the server automatically generates and attaches a UUID.

#### Response

- **Status 200 OK**:
  ```json
  {
    "id": "usr_9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "authId": "auth_google_1029384756",
    "email": "user@example.com",
    "displayName": "Alice",
    "status": "DISABLED",
    "authProvider": "GOOGLE",
    "defaultNetwork": "TESTNET",
    "createdAt": "2026-08-31T00:00:00.000Z",
    "updatedAt": "2026-10-01T12:00:00.000Z",
    "deletedAt": "2026-10-01T12:00:00.000Z"
  }
  ```
- **Status 401 Unauthorized**: Missing or invalid API key.
- **Status 404 Not Found**: User ID does not exist.
- **Status 500 / 503 Internal Server Error**: Dependency failure; deletion not confirmed.

---

## 4. Observability & Operational Runbook

### Metrics
- `user.deletion.success`: Counter incremented upon successful soft-delete.
- Correlation IDs are logged for every invocation (`requestId=...`), with all PII and credentials redacted.

### Rollback & Recovery
- In the event of accidental deletion requests prior to hard-scrubbing, accounts can be inspected via database administrative tooling. However, status transitions to `DISABLED` prevent any automated API writes while under review.
