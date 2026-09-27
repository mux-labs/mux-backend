# Key Management Quick Reference

## StrKeyHelper Import

```typescript
import { StrKeyHelper } from './key-management/utils/strkey.helper';
```

## One-Liners

### Encode

```typescript
// Encode a raw 32-byte public key
const publicKey = StrKeyHelper.encodeEd25519PublicKey(rawBuffer);
// => "GABC..."

// Encode a raw 32-byte secret seed
const secretSeed = StrKeyHelper.encodeEd25519SecretSeed(rawBuffer);
// => "SABC..."

// Encode a transaction hash
const preAuthTx = StrKeyHelper.encodePreAuthTx(hashBuffer);
// => "TABC..."

// Encode a SHA256 hash
const sha256Hash = StrKeyHelper.encodeSha256Hash(hashBuffer);
// => "XABC..."
```

### Decode

```typescript
// Decode a public key
const rawBuffer = StrKeyHelper.decodeEd25519PublicKey('GABC...');

// Decode a secret seed
const rawBuffer = StrKeyHelper.decodeEd25519SecretSeed('SABC...');

// Decode a pre-auth tx
const rawBuffer = StrKeyHelper.decodePreAuthTx('TABC...');

// Decode a SHA256 hash
const rawBuffer = StrKeyHelper.decodeSha256Hash('XABC...');
```

### Validate

```typescript
// Validate a public key
const isValid = StrKeyHelper.isValidEd25519PublicKey('GABC...');

// Validate a secret seed
const isValid = StrKeyHelper.isValidEd25519SecretSeed('SABC...');

// Validate a pre-auth tx
const isValid = StrKeyHelper.isValidPreAuthTx('TABC...');

// Validate a SHA256 hash
const isValid = StrKeyHelper.isValidSha256Hash('XABC...');
```

### Type Detection

```typescript
const info = StrKeyHelper.getStrKeyType('GABC...');
// => { isValid: true, type: 'ed25519PublicKey', prefix: 'G' }
```

### Security

```typescript
// Mask a key for safe logging
const masked = StrKeyHelper.maskKey('GABC...');
// => "GABC********************XYZ9"

// Quick secret detection
const isSecret = StrKeyHelper.looksLikeSecretSeed('SABC...');
// => true
```
