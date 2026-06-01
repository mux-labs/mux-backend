# Key Management: Document Custody Security Model

## Summary

Documents the full server-side custodial security model for Mux Backend's key management system. Adds both a human-readable narrative document and a machine-readable runtime summary exposed via API.

## Changes

### Documentation
- `docs/custody-security-model.md` — full narrative covering:
  - Key generation flow (stellar-sdk Ed25519, in-memory-only plaintext)
  - Encryption at rest (AES-256-GCM, random IV, GCM auth tag, AAD binding)
  - Signing flow (no private key exposure)
  - Key rotation chain (`rotatedFromId` backward + `successorId` forward links)
  - Wallet status lifecycle and terminal states
  - Audit logging (operations, in-memory cap, production guidance)
  - Internal API endpoint reference
  - Provider abstraction (HSM/KMS upgrade path)
  - Security properties summary table
  - Known MVP limitations
  - Environment variable reference

### Runtime (`src/key-management/key-management.service.ts`)
- Added `SecurityModelSummary` interface.
- Added `getSecurityModel()` method returning a structured, machine-readable summary that mirrors the doc. This makes the security model introspectable and testable.

### API (`src/key-management/key-management.controller.ts`)
- Added `GET /internal/key-management/security-model` endpoint.

### Tests (`src/key-management/key-management.service.spec.ts`)
- 7 new unit tests for `getSecurityModel` covering: custody model identifier, encryption parameters, plaintext exposure policy, rotation chain fields, atomic transaction flag, registered providers, and docs path reference.
- All 15 tests pass.

### Bug fix
- Fixed invalid JSON in `package.json` (trailing comma after `stellar-sdk` dependency).

closes #210
