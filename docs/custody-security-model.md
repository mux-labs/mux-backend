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
     │        └── EncryptionService   (AES-256-GCM versioned envelope)
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

## Key Versions & Envelope Scheme

Custody key material is encrypted at rest using a **versioned envelope scheme**. Every encrypted record carries an explicit key version so that decryption always selects the exact key that produced the ciphertext — there is no implicit "current key" fallback.

### Envelope format

```json
{
  "v": 2,
  "keyVersion": 3,
  "encryptedData": "<hex>",
  "iv": "<hex>",
  "tag": "<hex>"
}
```

| Field | Meaning |
|---|---|
| `v` | Envelope format version (structure of this JSON). |
| `keyVersion` | Identifier of the encryption key used. Recorded per wallet/key record. |
| `encryptedData` / `iv` / `tag` | AES-256-GCM ciphertext, IV, and auth tag. |

### Key version registry

- Encryption keys are addressed by an integer `keyVersion` (monotonically increasing).
- The active key version is configured via `WALLET_ENCRYPTION_KEY_VERSION`; the key material for each version is supplied via `WALLET_ENCRYPTION_KEY_<version>` (or a KMS/secret-manager reference).
- New writes always use the active key version and record it in the envelope.
- Reads select the key by the envelope's `keyVersion` — never by the active version.

### Typed API

`EncryptionService` exposes a stable, typed surface:

- `encrypt(plaintext, keyVersion?)` → `EncryptedEnvelope` (defaults to the active key version).
- `decrypt(envelope)` → plaintext, selecting the key from `envelope.keyVersion`.
- `encryptAndSerialize` / `deserializeAndDecrypt` wrap the same logic for the persisted column format.

### Fail-closed decryption

Decryption **never** falls back to plaintext and never guesses a key version. The following conditions fail closed with stable error codes:

| Condition | Error code |
|---|---|
| Envelope missing / malformed | `CUSTODY_ENVELOPE_INVALID` |
| Unknown `keyVersion` (no key configured) | `CUSTODY_KEY_VERSION_UNKNOWN` |
| Auth tag mismatch (tampered / wrong key) | `CUSTODY_DECRYPT_FAILED` |
| Missing key material for a version | `CUSTODY_KEY_MATERIAL_MISSING` |

Errors carry a correlation id and **never** include raw key material, ciphertext, IVs, tags, or secrets. Logs redact the same fields.

### Rotation of encryption keys

Encryption-key rotation is independent of wallet rotation:

1. Introduce a new key version and set it active.
2. New writes use the new version; existing records keep their recorded `keyVersion` and remain decryptable.
3. Re-encrypt records lazily or via a background job, updating `keyVersion` on each record.
4. Retire old key versions only after all records referencing them are re-encrypted.

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

- Only `ACTIVE` or `ROTATING` 

/* … truncated 4601 chars — edit only what you need near the top … */
