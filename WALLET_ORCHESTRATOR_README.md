# Wallet Creation Orchestrator

## Overview

The Wallet Creation Orchestrator is a core service that combines user lookup, key generation, and wallet persistence into an atomic, idempotent operation. It implements the invisible wallet flow for the Mux Protocol backend.

## Features

- **Atomic Operations**: All wallet creation steps are wrapped in database transactions
- **Idempotency**: Multiple calls with the same user ID return the existing wallet
- **Security**: Private keys are encrypted using AES encryption before storage
- **Error Handling**: Comprehensive error handling with proper rollback mechanisms
- **One Wallet Per User**: Enforced at the database level with unique constraints

## Architecture

### Core Components

1. **User Lookup**: Validates user existence before wallet creation
2. **Key Generation**: Creates Stellar keypairs using `@stellar/stellar-sdk`
3. **Encryption**: Encrypts private keys using AES encryption
4. **Persistence**: Stores encrypted wallet data in PostgreSQL via Prisma

### Database Schema

```sql
-- Users table
CREATE TABLE users (
  id        TEXT PRIMARY KEY DEFAULT cuid(),
  email     TEXT UNIQUE NOT NULL,
  createdAt TIMESTAMP DEFAULT NOW(),
  updatedAt TIMESTAMP DEFAULT NOW()
);

-- Wallets table (one-to-one with users)
CREATE TABLE wallets (
  id           TEXT PRIMARY KEY DEFAULT cuid(),
  userId       TEXT UNIQUE NOT NULL,
  publicKey    TEXT UNIQUE NOT NULL,
  encryptedKey TEXT NOT NULL,
  createdAt    TIMESTAMP DEFAULT NOW(),
  updatedAt    TIMESTAMP DEFAULT NOW(),
  
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
```

## API Usage

### Create Wallet

```typescript
POST /wallets/create-user-wallet
Content-Type: application/json

{
  "userId": "user-123",
  "encryptionKey": "super-secret-key"
}
```

Response:
```json
{
  "walletId": "wallet-456",
  "publicKey": "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
  "userId": "user-123"
}
```

### Get Wallet by User ID

```typescript
GET /wallets/user/{userId}
```

## Implementation Details

### Transaction Flow

1. **Start Database Transaction**
2. **Resolve User**: Verify user exists
3. **Check Existing Wallet**: Return existing wallet if found (idempotency)
4. **Generate Keypair**: Create new Stellar keypair
5. **Encrypt Private Key**: Use AES encryption with provided key
6. **Persist Wallet**: Store encrypted data in database
7. **Commit Transaction**: Atomic commit or rollback

### Security Considerations

- Private keys are never exposed outside the service
- Encryption keys are provided by the calling service (not stored)
- Database transactions ensure no partial state corruption
- Unique constraints prevent duplicate wallets

### Error Handling

- `NotFoundException`: User not found
- `ConflictException`: Database constraint violations
- `Error`: Encryption/decryption failures
- Automatic rollback on any transaction failure

## Testing

### Unit Tests

```bash
# Run orchestrator tests
pnpm test -- wallet-creation.orchestrator
```

### Integration Examples

See `src/wallets/orchestrator/integration-test.example.ts` for practical usage examples.

## Dependencies

- `@stellar/stellar-sdk`: Stellar keypair generation
- `crypto-js`: AES encryption for private keys
- `@prisma/client`: Database operations
- `@nestjs/common`: NestJS framework utilities

## Acceptance Criteria Met

✅ **One wallet per user enforced** - Database unique constraint
✅ **Wallet creation is atomic** - Database transactions
✅ **Partial failures do not leave broken state** - Transaction rollback
✅ **Idempotency ensured** - Returns existing wallet on duplicate calls
✅ **Secure key storage** - AES encryption of private keys

## Future Enhancements

- Key rotation support
- Multi-signature wallets
- Hardware security module (HSM) integration
- Wallet recovery mechanisms
