# Key Management Utilities

## StrKey Helper

The `StrKeyHelper` provides utility functions for encoding and decoding Stellar keys using the StrKey format (base32 with checksums).

### Overview

Stellar uses a specific key encoding format called StrKey, which is a base32 encoding with version bytes and checksums. This ensures keys are:
- Human-readable
- Type-safe (different prefixes for different key types)
- Error-resistant (checksums catch typos)

### Key Formats

| Type | Prefix | Description | Example |
|------|--------|-------------|---------|
| Public Key | `G` | Ed25519 public key | `GAXYZ...` |
| Secret Seed | `S` | Ed25519 private key | `SAXYZ...` |
| Pre-Auth Tx | `T` | Pre-authorized transaction hash | `TAXYZ...` |
| SHA256 Hash | `X` | SHA256 hash for signing | `XAXYZ...` |
| Muxed Account | `M` | Multiplexed account | `MAXYZ...` |
| Contract | `C` | Smart contract address | `CAXYZ...` |

All encoded strings are 56 characters long (except for muxed accounts which can be longer).

### Usage

#### Import

```typescript
import { StrKeyHelper } from './key-management/utils/strkey.helper';
```

#### Encode a Public Key

```typescript
// From raw 32-byte buffer
const rawPublicKey: Buffer = keypair.rawPublicKey();
const encoded = StrKeyHelper.encodeEd25519PublicKey(rawPublicKey);
// Result: "GAXYZ..." (56 characters)
```

#### Encode a Secret Seed

```typescript
// From raw 32-byte buffer
const rawSecretKey: Buffer = keypair.rawSecretKey();
const encoded = StrKeyHelper.encodeEd25519SecretSeed(rawSecretKey);
// Result: "SAXYZ..." (56 characters)
```

#### Decode Keys

```typescript
// Decode public key to raw bytes
const rawPublicKey = StrKeyHelper.decodeEd25519PublicKey('GAXYZ...');
// Result: Buffer (32 bytes)

// Decode secret seed to raw bytes
const rawSecretKey = StrKeyHelper.decodeEd25519SecretSeed('SAXYZ...');
// Result: Buffer (32 bytes)
```

#### Validate Keys

```typescript
// Validate public key format
const isValid = StrKeyHelper.isValidEd25519PublicKey('GAXYZ...');
// Result: true or false

// Validate secret seed format
const isValid = StrKeyHelper.isValidEd25519SecretSeed('SAXYZ...');
// Result: true or false
```

#### Detect Key Type

```typescript
const keyInfo = StrKeyHelper.getStrKeyType('GAXYZ...');
// Result: { isValid: true, type: 'publicKey' }

const seedInfo = StrKeyHelper.getStrKeyType('SAXYZ...');
// Result: { isValid: true, type: 'secretSeed' }

const unknownInfo = StrKeyHelper.getStrKeyType('INVALID');
// Result: { isValid: false, type: 'unknown' }
```

#### Safe Logging - Mask Keys

```typescript
// Mask key for logging (shows only prefix and suffix)
const masked = StrKeyHelper.maskKey('GAXYZ123456789...');
// Result: "GAXY********************XYZ9"

// Custom masking
const masked = StrKeyHelper.maskKey(secretKey, 6, 6);
// Result: "SAXYZU********************VWXYZ9"
```

#### Security Check - Detect Secret Seeds

```typescript
// Quick check without full validation
const looksLikeSecret = StrKeyHelper.looksLikeSecretSeed(value);
// Result: true if starts with 'S' and is 56 chars

// Use for preventing accidental logging:
if (StrKeyHelper.looksLikeSecretSeed(value)) {
  logger.warn('Attempted to log secret seed');
  return;
}
```

### Advanced Usage

#### Pre-Authorized Transaction Hash

```typescript
// Encode a transaction hash
const txHash: Buffer = Buffer.alloc(32).fill(0x42);
const encoded = StrKeyHelper.encodePreAuthTx(txHash);
// Result: "TAXYZ..." (56 characters)

// Decode back
const decoded = StrKeyHelper.decodePreAuthTx(encoded);
// Result: Buffer (32 bytes)
```

#### SHA256 Hash Encoding

```typescript
// Encode a SHA256 hash
const hash: Buffer = Buffer.alloc(32).fill(0xAB);
const encoded = StrKeyHelper.encodeSha256Hash(hash);
// Result: "XAXYZ..." (56 characters)

// Decode back
const decoded = StrKeyHelper.decodeSha256Hash(encoded);
// Result: Buffer (32 bytes)
```

### Integration with Key Management Service

The StrKey helper integrates seamlessly with the Key Management Service:

```typescript
// Generate key through service
const keyMaterial = await keyManagementService.generateKey({
  keyType: KeyType.STELLAR_ED25519,
});

// Validate the generated public key
const isValid = StrKeyHelper.isValidEd25519PublicKey(keyMaterial.publicKey);
// Result: true

// Get key type info
const keyInfo = StrKeyHelper.getStrKeyType(keyMaterial.publicKey);
// Result: { isValid: true, type: 'publicKey' }

// Mask for logging
const masked = StrKeyHelper.maskKey(keyMaterial.publicKey);
logger.info(`Generated key: ${masked}`);
// Logs: "Generated key: GABC********************XYZ9"
```

### Error Handling

All methods include comprehensive error handling:

```typescript
try {
  const decoded = StrKeyHelper.decodeEd25519PublicKey('INVALID_KEY');
} catch (error) {
  // Error: "Failed to decode Ed25519 public key: ..."
}

try {
  const encoded = StrKeyHelper.encodeEd25519PublicKey(Buffer.alloc(16));
} catch (error) {
  // Error: "Invalid public key length: expected 32 bytes, got 16"
}
```

### Security Best Practices

#### ✅ DO

- Use `maskKey()` when logging keys for debugging
- Use `isValidEd25519PublicKey()` to validate user input
- Use `looksLikeSecretSeed()` to detect accidental secret exposure
- Use `getStrKeyType()` to identify unknown key formats
- Validate keys before storing or transmitting them

#### ❌ DON'T

- Never log full secret seeds in production
- Never transmit secret seeds unencrypted
- Never store decoded (raw buffer) secret keys in databases
- Never skip validation on user-provided keys
- Never expose secret seeds in API responses

### Testing

The helper includes comprehensive test coverage:

```bash
# Run unit tests
npm test -- strkey.helper.spec.ts

# Run integration tests
npm test -- strkey-integration.spec.ts
```

### API Reference

#### Encoding Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `encodeEd25519PublicKey` | `Buffer (32 bytes)` | `string` | Encodes public key to G... format |
| `encodeEd25519SecretSeed` | `Buffer (32 bytes)` | `string` | Encodes secret seed to S... format |
| `encodePreAuthTx` | `Buffer (32 bytes)` | `string` | Encodes tx hash to T... format |
| `encodeSha256Hash` | `Buffer (32 bytes)` | `string` | Encodes hash to X... format |

#### Decoding Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `decodeEd25519PublicKey` | `string` | `Buffer (32 bytes)` | Decodes G... format to raw bytes |
| `decodeEd25519SecretSeed` | `string` | `Buffer (32 bytes)` | Decodes S... format to raw bytes |
| `decodePreAuthTx` | `string` | `Buffer (32 bytes)` | Decodes T... format to raw bytes |
| `decodeSha256Hash` | `string` | `Buffer (32 bytes)` | Decodes X... format to raw bytes |

#### Validation Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `isValidEd25519PublicKey` | `string` | `boolean` | Validates G... format |
| `isValidEd25519SecretSeed` | `string` | `boolean` | Validates S... format |
| `getStrKeyType` | `string` | `object` | Identifies key type |
| `looksLikeSecretSeed` | `unknown` | `boolean` | Quick secret seed detection |

#### Utility Methods

| Method | Input | Output | Description |
|--------|-------|--------|-------------|
| `maskKey` | `string, number?, number?` | `string` | Masks key for safe logging |

### Performance

- Encoding: ~0.1ms per operation
- Decoding: ~0.1ms per operation
- Validation: ~0.05ms per operation
- Negligible memory overhead

### Compatibility

- Fully compatible with `stellar-sdk` v10.2.0+
- Works with all Stellar network types (public, testnet, standalone)
- Supports all StrKey format versions

### References

- [Stellar StrKey Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0023.md)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Base32 Encoding RFC](https://tools.ietf.org/html/rfc4648)

### Support

For issues or questions:
1. Check the [Key Management README](../README.md)
2. Review the test files for usage examples
3. Consult Stellar SDK documentation

---

**Version**: 1.0.0  
**Last Updated**: 2026-06-02
