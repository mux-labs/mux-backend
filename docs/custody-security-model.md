# Custody Security Model

Mux Backend uses a **server-side custodial model** for Stellar keypairs. This document describes every layer of that model: how keys are generated, stored, used, rotated, and audited.

---

## Overview

Users never see or manage private keys. Mux Backend generates, encrypts, and stores them on behalf of users. All signing happens server-side. The platform is the sole custodian.

```
User / Client
     │  (no key material ever crosses this boundary)
     ▼
Identity Provider (Clerk / Better Auth)
     ├─ Authenticates user, issues signed JWT
     │
User / Client (presents JWT)
     │
     ▼
Mux Backend API  ← JwtVerificationService verifies JWT sig, extracts identity
     │           ← Only trusts identity from verified JWT claims (sub, auth_provider)
     │           ← Checks local user status (ACTIVE/INACTIVE/SUSPENDED)
     │
     ├── AuthOrchestrator  ← Orchestrates auth, wallet creation
     │
     ├── KeyManagementService  ← only layer that touches plaintext keys (briefly)
     │        │
     │        ├── StellarKeyProvider  (stellar-sdk Keypair generation + signing)
     │        └── EncryptionService   (AES-256-GCM envelope)
     │
     └── PostgreSQL  ← stores encrypted key material + user status
```

### Authentication Boundary

The critical security boundary is at "Mux Backend API" where identity is verified:

1. **Token Arrival**: Client sends Authorization header with a signed JWT token.
2. **Signature Verification**: JwtVerificationService verifies the token signature cryptographically against the identity provider's public keys.
3. **Identity Extraction**: User identity is extracted **only** from verified JWT claims (`sub` and `auth_provider`). Client-supplied identity fields in the request body are ignored.
4. **Status Check**: Local user record is loaded and status is checked. Users with status other than `ACTIVE` are rejected.
5. **Protected Access**: Only after both JWT verification and status check pass can the user access protected resources or have key operations performed on their behalf.

At no point do any downstream layers (KeyManagementService, Stellar, database) trust identity directly. Identity is always passed through after verification by JwtVerificationService and AuthOrchestrator.

---

## Authentication & Trust Model

Authentication is the foundation of custody security. If identity is not verified, an attacker could impersonate a legitimate user and access their keys and transactions.

### Server-Side Verification Only

Mux Backend verifies identity server-side using cryptographic JWT verification, not by trusting client-supplied claims:

| Layer | What is Trusted | Why |
|---|---|---|
| **Client** (untrusted) | None. All client claims are ignored. | Clients can be compromised or malicious. |
| **Identity Provider** (verified) | JWT token signature. User identity from verified token claims. | Provider's keys are rotated and managed by the provider. Signature proves the token came from them. |
| **Mux Backend** | Verified JWT claims + local user status. | After cryptographic verification, we check our own records for user status. |

### Verification Flow for Every Request

1. **Request Arrives**: Client sends HTTP request with `Authorization: Bearer <jwt_token>`.

2. **Token Extraction**: `JwtVerificationService.extractBearerToken()` extracts the token from the Authorization header. If missing, request fails with 400 Bad Request.

3. **Signature Verification**: `JwtVerificationService.verifyToken()` verifies the JWT signature against the configured identity provider's public keys. If verification fails (invalid signature, expired token, wrong provider), request fails with 401 Unauthorized.

4. **Identity Extraction**: From the verified token, extract:
   - `sub` claim → becomes `authId` (user's unique ID in the identity provider)
   - `auth_provider` claim → becomes `authProvider` (e.g., "CLERK", "BETTER_AUTH")

5. **Status Check**: Look up the user in the local database by `authId`. If found, check the user's `status` field. If status is not `ACTIVE` (e.g., `SUSPENDED`, `INACTIVE`), reject with 403 Forbidden. If user not found, proceed (new user).

6. **Protected Operation**: Only after verification and status check pass can the operation proceed. The now-verified identity is used throughout the request lifecycle.

### What is NOT Trusted

- **Client-supplied authId/authProvider**: These are ignored. Identity comes from the verified JWT token.
- **Email address**: Optional metadata that may be passed in the request body. Used for record-keeping but not for identity.
- **Display name**: Optional metadata.
- **Token expiration**: Handled by the JWT library. Expired tokens are rejected at verification time.
- **Provider profile fields**: Any data relayed from the identity provider (e.g., email stored in Clerk) is not used for access control.

### Production Safety

In production:
- JWT verification library must be installed (currently requires manual add of `jsonwebtoken` package).
- Identity provider configuration must be set (e.g., `CLERK_JWT_PUBLIC_KEY` or `BETTER_AUTH_JWKS_URL`).
- If either is missing, startup fails or requests fail with 503 Service Unavailable. There is no fallback to trusting client-supplied identity.

---

## Key Generation

1. `KeyManagementService.generateKey()` calls `StellarKeyProvider.generateKeyPair()`.
2. The provider uses `stellar-sdk`'s `Keypair.random()` to produce a cryptographically random Ed25519 keypair.
3. The plaintext secret seed (`S...` Stellar format) is passed **immediately** to `EncryptionService.encryptAndSerialize()`.
4. The plaintext is never stored, logged, or returned. Only the encrypted envelope is persisted.

**Invariant:** Private key material exists in plaintext only in process memory, for the duration of a single function call.

---

## Encryption at Rest

All private key material is encrypted with **AES-256-GCM** before being written to the database.

| Property | Value |
|---|---|
| Algorithm | AES-256-GCM |
| Key length | 256 bits |
| IV length | 128 bits (random per encryption) |
| Auth tag length | 128 bits |
| AAD | `"wallet-secret"` (binds ciphertext to its purpose) |
| Key derivation | `SHA-256(WALLET_ENCRYPTION_KEY env var)` |

The stored envelope is a JSON object serialized to a single column (`encryptedSecret`):

```json
{
  "encryptedData": "<hex>",
  "iv": "<hex>",
  "tag": "<hex>"
}
```

The `encryptionVersion` column tracks the envelope format version to support future key rotation or algorithm upgrades.

**Environment variable:** `WALLET_ENCRYPTION_KEY` — must be set in all environments. The application refuses to start without it.

---

## Signing

Private keys are **never returned** from any service or API. The only way to use a private key is through `KeyManagementService.sign()`:

1. The encrypted envelope is passed in.
2. `StellarKeyProvider.sign()` decrypts the envelope in memory.
3. `stellar-sdk`'s `Keypair.sign()` produces the Ed25519 signature.
4. The decrypted key is discarded; only the signature is returned.

No API endpoint returns private key material. The `POST /internal/key-management/sign` endpoint returns only `{ signature, publicKey, algorithm, timestamp }`.

---

## Key Rotation

Key rotation creates a new keypair and links it to the old one, preserving the full rotation chain.

### Rotation flow

```
Wallet A (ACTIVE)
  │
  │  POST /internal/key-management/rotate  { walletId: A }
  ▼
[Transaction]
  ├── Create Wallet B (ACTIVE, rotatedFromId = A, secretVersion = A.secretVersion + 1)
  └── Update Wallet A (status = ROTATING, successorId = B)
```

### Rotation chain fields

| Field | Direction | Description |
|---|---|---|
| `rotatedFromId` | backward | Points to the wallet this one replaced |
| `successorId` | forward | Points to the wallet that replaced this one |

Both fields together allow traversal of the full rotation history in either direction.

### Rotation guards

- Only `ACTIVE` or `ROTATING` wallets can be rotated.
- A wallet that already has a `successorId` cannot be rotated again (prevents double-rotation).
- All DB writes (create successor + update predecessor) are atomic via `prisma.$transaction`.
- The `/internal/key-management/rotate` route is gated by `FeatureFlagGuard` **and**
  `InternalServiceGuard` (`x-internal-api-key` header, issue #690).
- `KeyManagementService.rotateKey` is the **only** rotation implementation.
  `WalletsService.rotateWalletKey` delegates to it (issue #692) and rotation is
  never exposed on the public `/v1/wallets` API (issue #691).

### Wallet status lifecycle

```
PROVISIONING → ACTIVE → ROTATING → (successor takes over)
                      ↘ SUSPENDED → ACTIVE
                      ↘ DISABLED   (terminal)
                      ↘ COMPROMISED (terminal)
```

`DISABLED` and `COMPROMISED` are terminal states — no further transitions are allowed.

---

## Audit Logging

Every key operation is recorded in an in-memory audit log via `KeyManagementService.auditKeyOperation()`. No sensitive data is ever included.

| Operation | Triggered by |
|---|---|
| `GENERATE` | `generateKey()` |
| `SIGN` | `sign()` |
| `ROTATE` | `rotateKey()` |

Each entry contains: `operation`, `keyId`, `publicKey` (first 12 chars in logs), `timestamp`, `success`, and optional `errorMessage`.

The log is capped at 1,000 entries in memory. In production, entries should be forwarded to an external audit system (e.g., CloudWatch, Datadog).

Retrieve via: `GET /internal/key-management/audit?limit=100`

---

## Internal API Endpoints

All endpoints are under `/internal/key-management` and must **not** be exposed to public traffic. They are intended for internal service-to-service calls only.

| Method | Path | Description |
|---|---|---|
| `POST` | `/internal/key-management/generate` | Generate a new encrypted keypair |
| `POST` | `/internal/key-management/sign` | Sign data without exposing the private key |
| `POST` | `/internal/key-management/validate` | Validate that a public key matches encrypted material |
| `POST` | `/internal/key-management/rotate` | Rotate a wallet's key and link the successor |
| `GET` | `/internal/key-management/audit` | Retrieve the in-memory audit log |
| `GET` | `/internal/key-management/security-model` | Machine-readable summary of this security model |

---

## Provider Abstraction

`KeyManagementService` delegates all cryptographic operations to `IKeyProvider` implementations. The current provider is `StellarKeyProvider` (Ed25519 via `stellar-sdk`).

This abstraction allows future migration to:
- **HSM** (Hardware Security Module) — keys never leave hardware
- **AWS KMS / GCP Cloud KMS** — cloud-managed key material
- **Ethereum secp256k1** — for EVM chain support

The `KeyType` enum (`STELLAR_ED25519`, `ETHEREUM_SECP256K1`) is the discriminator for provider selection.

---

## Security Properties (Summary)

| Property | Status |
|---|---|
| Private keys never returned to clients | ✅ Enforced |
| Private keys never logged | ✅ Enforced |
| Encryption at rest (AES-256-GCM) | ✅ Active |
| Random IV per encryption | ✅ Active |
| GCM authentication tag (tamper detection) | ✅ Active |
| All key operations audited | ✅ Active |
| Rotation chain preserved (forward + backward links) | ✅ Active |
| Atomic rotation (no partial state) | ✅ Enforced via DB transaction |
| Terminal states for compromised/disabled wallets | ✅ Enforced |

---

## Known Limitations (MVP)

- The encryption key (`WALLET_ENCRYPTION_KEY`) is a single symmetric key. Compromise of this key compromises all stored secrets. Production should use a KMS with envelope encryption.
- The audit log is in-memory only. Restarts lose history. Production should persist to an external audit store.
- There is no automatic key rotation schedule. Rotation must be triggered manually via the API.
- `reEncryptKey()` currently generates a throwaway keypair to satisfy the return type — this method needs a proper implementation before use in production.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WALLET_ENCRYPTION_KEY` | Yes | Master encryption key for AES-256-GCM. Must be kept secret. |
| `DATABASE_URL` | Yes | PostgreSQL connection string for encrypted key storage. |
