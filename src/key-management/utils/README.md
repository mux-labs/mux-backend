# StrKey Helper

A comprehensive utility for encoding, decoding, and validating Stellar StrKey formatted keys (SEP-23) in the Mux Protocol key management system.

## Overview

The StrKey Helper provides production-grade utilities for working with Stellar's StrKey address format. It supports Ed25519 public keys, secret seeds, pre-authorized transactions, and SHA256 hashes.

## Installation

The StrKeyHelper is part of the `key-management` module and is automatically available when the module is imported.

## Quick Start

```typescript
import { StrKeyHelper } from './key-management/utils/strkey.helper';

const helper = new StrKeyHelper();

// Encode a raw 32-byte public key
const publicKey = helper.encodeEd25519PublicKey(rawBuffer);

// Validate a StrKey-formatted public key
const isValid = helper.isValidEd25519PublicKey(publicKey);

// Decode a StrKey-formatted public key to raw bytes
const decoded = helper.decodeEd25519PublicKey(publicKey);

// Mask a key for safe logging
const masked = helper.maskKey(publicKey);
```

## API Reference

### Encoding Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `encodeEd25519PublicKey` | `Buffer (32 bytes)` | `string` | Encode raw public key to G... format |
| `encodeEd25519SecretSeed` | `Buffer (32 bytes)` | `string` | Encode raw secret seed to S... format |
| `encodePreAuthTx` | `Buffer (32 bytes)` | `string` | Encode transaction hash to T... format |
| `encodeSha256Hash` | `Buffer (32 bytes)` | `string` | Encode SHA256 hash to X... format |

### Decoding Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `decodeEd25519PublicKey` | `string` | `Buffer (32 bytes)` | Decode G... format to raw bytes |
| `decodeEd25519SecretSeed` | `string` | `Buffer (32 bytes)` | Decode S... format to raw bytes |
| `decodePreAuthTx` | `string` | `Buffer (32 bytes)` | Decode T... format to raw bytes |
| `decodeSha256Hash` | `string` | `Buffer (32 bytes)` | Decode X... format to raw bytes |

### Validation Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `isValidEd25519PublicKey` | `unknown` | `boolean` | Validate public key format |
| `isValidEd25519SecretSeed` | `unknown` | `boolean` | Validate secret seed format |
| `isValidPreAuthTx` | `unknown` | `boolean` | Validate pre-auth tx format |
| `isValidSha256Hash` | `unknown` | `boolean` | Validate SHA256 hash format |

### Type Detection

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `getStrKeyType` | `unknown` | `StrKeyTypeInfo` | Identify key type and validity |

### Security Utilities

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `looksLikeSecretSeed` | `unknown` | `boolean` | Quick detection of secret seed patterns |
| `maskKey` | `unknown, number?, number?` | `string` | Mask keys for safe logging |

## Error Handling

All methods include comprehensive error handling with stable error codes:

- `STRKEY_INVALID_INPUT_TYPE` — Input is not the expected type
- `STRKEY_INVALID_LENGTH` — Input buffer is not 32 bytes (for encoding) or string is not 56 characters (for decoding)
- `STRKEY_INVALID_PREFIX` — String has an unexpected StrKey prefix
- `STRKEY_INVALID_CHECKSUM` — StrKey checksum verification failed
- `STRKEY_INVALID_KEY_TYPE` — Key type does not match the expected type
- `STRKEY_ENCODING_FAILED` — Encoding operation failed
- `STRKEY_DECODING_FAILED` — Decoding operation failed

## Security Features

1. **Secret Protection**
   - Never logs full secret seeds
   - Provides masking utility for safe logging
   - Quick detection to prevent accidental exposure

2. **Input Validation**
   - All inputs type-checked
   - Buffer lengths verified
   - Key prefixes validated
   - Checksums verified

3. **Graceful Error Handling**
   - Validation methods return `false` (never throw) for invalid inputs
   - Encoding/decoding methods throw typed errors with stable error codes
   - Error messages never contain raw key material

## Testing

### Running Tests

```bash
# Run all StrKey tests
npm test -- strkey

# Run specific test files
npm test -- strkey.helper.spec.ts
npm test -- strkey-integration.spec.ts
npm test -- strkey.contract.spec.ts

# Run with coverage
npm test -- --coverage strkey
```

### Test Coverage

- **Unit Tests** (`strkey.helper.spec.ts`) — 100+ test cases covering encoding, decoding, validation, type detection, masking, and edge cases
- **Integration Tests** (`strkey-integration.spec.ts`) — Real-world workflows including key generation, audit logging, batch validation, and concurrent operations
- **Contract Tests** (`strkey.contract.spec.ts`) — SEP-23 protocol compliance, checksum validation, cross-verification, and performance benchmarks

## Performance

Benchmarks from contract tests:
- Encoding: ~0.1ms per operation
- Decoding: ~0.1ms per operation
- Validation: ~0.05ms per operation
- 10,000 encodings: < 5 seconds
- 10,000 validations: < 2 seconds

## Compatibility

- ✅ Fully compatible with Stellar StrKey format (SEP-23)
- ✅ All encoding matches the Stellar SDK output format
- ✅ All decoding produces correct 32-byte buffers
- ✅ All validation results are consistent with Stellar protocol

## Security Considerations

### ✅ Implemented Safeguards

1. **No Secret Exposure**
   - Keys masked in logs by default
   - Quick detection prevents accidental logging
   - Error messages don't expose sensitive data

2. **Input Validation**
   - All inputs validated before processing
   - Type checking prevents type confusion
   - Length validation ensures correct data

3. **Graceful Error Handling**
   - Invalid states handled without exposing internals
   - Clear error messages for debugging
   - Stable error codes for client branching

4. **Audit Trail**
   - All operations can be logged safely with masking
   - Key type detection helps audit analysis
   - Integration with existing audit system

## Integration Points

The StrKeyHelper integrates with:

1. **Key Management Service** — Validates generated keys
2. **Stellar Key Provider** — Uses helper for validation
3. **Encryption Service** — Works with encrypted material
4. **Audit System** — Provides masked keys for logs
5. **API Endpoints** — Can validate request parameters
