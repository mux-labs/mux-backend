# KeyManagementService - Quick Reference

## Quick Start

### Import
```typescript
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
import { StrKeyHelper } from '../key-management/utils/strkey.helper';
```

### Inject
```typescript
constructor(
  private keyManagementService: KeyManagementService,
) {}
```

### Generate Key
```typescript
const keyMaterial = await this.keyManagementService.generateKey({
  keyType: KeyType.STELLAR_ED25519,
  metadata: { userId: 'user-123', purpose: 'wallet' },
});

// Returns:
// {
//   encryptedData: string,    // Store this
//   publicKey: string,         // Store this
//   keyType: KeyType,
//   encryptionVersion: number
// }
```

### Sign Data
```typescript
const signature = await this.keyManagementService.sign({
  encryptedKeyMaterial: wallet.encryptedSecret,
  dataToSign: Buffer.from('transaction-data'),
  publicKey: wallet.publicKey,
});

// Returns:
// {
//   signature: string,
//   publicKey: string,
//   algorithm: string,
//   timestamp: Date
// }
```

### Validate Key
```typescript
const isValid = await this.keyManagementService.validateKey(
  publicKey,
  encryptedKeyMaterial,
  KeyType.STELLAR_ED25519,
);
// Returns: boolean
```

## Common Patterns

### Wallet Creation
```typescript
async createWallet(userId: string) {
  const keyMaterial = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { userId, operation: 'create' },
  });
  
  await db.wallet.create({
    userId,
    publicKey: keyMaterial.publicKey,
    encryptedSecret: keyMaterial.encryptedData,
    encryptionVersion: keyMaterial.encryptionVersion,
  });
}
```

### Key Rotation
```typescript
async rotateKey(walletId: string) {
  const newKey = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { walletId, operation: 'rotation' },
  });
  
  await db.wallet.update({
    where: { id: walletId },
    data: {
      publicKey: newKey.publicKey,
      encryptedSecret: newKey.encryptedData,
      encryptionVersion: newKey.encryptionVersion,
      secretVersion: { increment: 1 },
    },
  });
}
```

### Signing Transaction
```typescript
async signTransaction(walletId: string, txData: Buffer) {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  
  const signature = await this.keyManagementService.sign({
    encryptedKeyMaterial: wallet.encryptedSecret,
    dataToSign: txData,
    publicKey: wallet.publicKey,
  });
  
  return signature.signature;
}
```

## Testing

### Mock Setup
```typescript
const mockKeyManagementService = {
  generateKey: jest.fn(),
  sign: jest.fn(),
  validateKey: jest.fn(),
  getAuditLog: jest.fn(),
};
```

### Mock Return Values
```typescript
mockKeyManagementService.generateKey.mockResolvedValue({
  encryptedData: 'mock-encrypted-key',
  publicKey: 'GMOCK123...',
  keyType: KeyType.STELLAR_ED25519,
  encryptionVersion: 1,
});

mockKeyManagementService.sign.mockResolvedValue({
  signature: 'mock-signature',
  publicKey: 'GMOCK123...',
  algorithm: 'ed25519',
  timestamp: new Date(),
});

mockKeyManagementService.validateKey.mockResolvedValue(true);
```

## Key Types

```typescript
enum KeyType {
  STELLAR_ED25519 = 'STELLAR_ED25519',      // ✅ Available
  ETHEREUM_SECP256K1 = 'ETHEREUM_SECP256K1', // Future
}
```

## Security Rules

### ✅ DO
- Use KeyManagementService for ALL key generation
- Store only encrypted key material in database
- Pass metadata for audit trail
- Handle errors gracefully
- Mock the service in unit tests
- Use real service in integration tests

### ❌ DON'T
- Never generate keys with `crypto` directly
- Never return plaintext private keys
- Never log private keys or encrypted material
- Never bypass KeyManagementService
- Never store plaintext keys
- Never transmit keys unencrypted

## Error Handling

```typescript
try {
  const key = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { userId: 'user-123' },
  });
} catch (error) {
  if (error instanceof NotFoundException) {
    // Invalid key type or provider not found
  } else {
    // Other error - log and handle
    this.logger.error('Key generation failed', error);
    throw new Error('Failed to create wallet key');
  }
}
```

## Audit Logs

### Get Logs
```typescript
const logs = keyManagementService.getAuditLog(100); // Last 100 entries
```

### Log Format
```typescript
{
  operation: 'GENERATE' | 'SIGN' | 'VALIDATE' | 'ROTATE' | 'REVOKE' | 'ACCESS',
  keyId: string,
  publicKey: string,
  timestamp: Date,
  success: boolean,
  metadata?: Record<string, any>,
  errorMessage?: string,
}
```

## Module Setup

### Import in Module
```typescript
import { KeyManagementModule } from '../key-management/key-management.module';

@Module({
  imports: [KeyManagementModule], // Add this
  providers: [YourService],
})
export class YourModule {}
```

## Performance

- Key generation: ~50-100ms
- Signing: ~10-20ms
- Validation: ~20-40ms
- Negligible memory overhead

## Support

### Resources
- [Full Documentation](./README.md)
- [Consolidation Guide](../../docs/key-management-consolidation.md)
- [Migration Guide](../../docs/MIGRATION-KEY-MANAGEMENT.md)

### Common Issues

**"No provider registered for key type"**
→ Use `KeyType.STELLAR_ED25519`

**"Cannot inject KeyManagementService"**
→ Import `KeyManagementModule` in your module

**"Tests failing with KMS"**
→ Mock the service (see Testing section)

**"Need private key temporarily"**
→ Decrypt from `encryptedData` using `EncryptionService`

## One-Liners

```typescript
// Generate Stellar key
const key = await kms.generateKey({ keyType: KeyType.STELLAR_ED25519, metadata: {} });

// Sign data
const sig = await kms.sign({ encryptedKeyMaterial, dataToSign, publicKey });

// Validate
const valid = await kms.validateKey(publicKey, encryptedMaterial, KeyType.STELLAR_ED25519);

// Get audit log
const logs = kms.getAuditLog(100);

// StrKey utilities
const isValid = StrKeyHelper.isValidEd25519PublicKey(publicKey);
const masked = StrKeyHelper.maskKey(publicKey);
const keyType = StrKeyHelper.getStrKeyType(value);
```

---

**Quick Reference Version**: 1.0  
**Module Version**: 1.0.0  
**Last Updated**: 2024-XX-XX
