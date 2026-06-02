# Key Management: Add Rotation Successor Linking

## Summary

Implements forward successor linking for wallet key rotation. Previously the `Wallet` model only tracked the predecessor (`rotatedFromId`), making it impossible to follow the rotation chain forward without a table scan. This PR adds a direct `successorId` field so each wallet can point to the wallet that replaced it.

## Changes

### Database
- Added `successorId` (nullable, unique) to the `Wallet` table with a self-referential FK constraint.
- Migration: `prisma/migrations/20260601000000_add_wallet_successor_id/migration.sql`

### Domain
- `src/wallets/domain/wallet.model.ts` — added `successorId` field to the `Wallet` interface.
- `src/wallets/wallets.service.ts` — `mapPrismaWalletToDomain` now maps `successorId`.

### Key Management
- `src/key-management/key-management.service.ts`
  - Injected `PrismaService`.
  - Added `rotateKey(predecessorWalletId)` method:
    1. Validates predecessor exists and is `ACTIVE` or `ROTATING`.
    2. Guards against double-rotation (already has a `successorId`).
    3. Generates a new Stellar keypair via `generateKey`.
    4. In a single DB transaction: creates the successor wallet (`ACTIVE`, `rotatedFromId` set) and updates the predecessor (`successorId` set, status → `ROTATING`).
    5. Emits a `ROTATE` audit log entry.
- `src/key-management/key-management.controller.ts`
  - Added `POST /internal/key-management/rotate` endpoint accepting `{ walletId }`.
  - Returns `{ predecessorWalletId, successorWalletId, successorPublicKey }`.

### Tests
- `src/key-management/key-management.service.spec.ts` — 17 unit tests covering:
  - Happy path (successor created and linked)
  - `rotatedFromId` set on successor
  - Predecessor transitioned to `ROTATING`
  - Rotation of a wallet already in `ROTATING` status
  - `NotFoundException` for missing wallet
  - Error for non-rotatable statuses (`DISABLED`, etc.)
  - Error when wallet already has a successor
  - Audit log entry on success
  - `secretVersion` incremented on successor

## API

```
POST /internal/key-management/rotate
Body:    { "walletId": "<predecessor-wallet-id>" }
Returns: { "predecessorWalletId": "...", "successorWalletId": "...", "successorPublicKey": "G..." }
```

## Notes
- The endpoint is internal-only and should not be exposed to public APIs.
- All DB writes are atomic (wrapped in `prisma.$transaction`).
- No private key material is ever returned or logged.

closes #211
