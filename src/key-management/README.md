# Key Management Module

The Key Management module provides centralized key generation, encoding, decoding, and validation for Stellar wallet operations in the Mux Protocol.

## Overview

This module uses the StrKeyHelper utility for all StrKey encoding and decoding operations, ensuring consistent and validated handling of Stellar keys.

## Components

### KeyManagementService

The primary service for Stellar key operations.

#### Methods

| Method | Description |
|--------|-------------|
| `generateKey()` | Generate a new Stellar keypair with StrKey encoding |
| `rotateKey(keyId)` | Rotate a key, returning a new key with incremented version |
| `validatePublicKey(publicKey)` | Validate a StrKey-formatted public key |
| `validateSecretSeed(secretSeed)` | Validate a StrKey-formatted secret seed |
| `getStrKeyType(value)` | Get the type of a StrKey-formatted value |
| `maskKey(key)` | Mask a key for safe logging |

### StrKeyHelper

The underlying utility for StrKey encoding, decoding, and validation.

#### Features

- Encoding: Ed25519 public keys (G...), secret seeds (S...), pre-auth tx (T...), SHA256 hashes (X...)
- Decoding: Convert StrKey-formatted strings back to raw 32-byte buffers
- Validation: Verify StrKey format, prefix, and checksum
- Type detection: Identify the type of any StrKey-formatted value
- Security: Masking utility for safe logging, secret detection

## Usage

```typescript
import { KeyManagementService } from './key-management/key-management.service';

const keyManagementService = app.get(KeyManagementService);

// Generate a new keypair
const keypair = await keyManagementService.generateKey();

// The public key is safe to log. The secret seed is NOT: never write it to a
// log, a response body, or the database in plaintext.
logger.log(`generated public key ${keypair.publicKey}`); // GABC...

// Encrypt the secret seed with EncryptionService before persisting it. Only
// the envelope (ciphertext + iv + tag) may reach the database.
const encryptedSecret = encryptionService.encryptAndSerialize(keypair.privateKey);

// Validate a public key
const isValid = keyManagementService.validatePublicKey('GABC...');

// Mask a key for logging
const masked = keyManagementService.maskKey(keypair.publicKey);
```

## Security

- Private keys are never logged or returned in API responses
- All key material is generated using a CSPRNG
- Key rotation is tracked via a version counter
- StrKey encoding/decoding is validated with checksum verification
- Input validation prevents type confusion and buffer overflows

## Integration

The KeyManagementModule is registered in the AppModule and provides:
- `KeyManagementService` - Primary key management operations
- `StrKeyHelper` - StrKey encoding/decoding/validation utility
