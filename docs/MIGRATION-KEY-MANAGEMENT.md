# Key Management Consolidation - Migration Guide

## Overview

This guide helps developers update their code to use the consolidated `KeyManagementService` instead of direct key generation.

## What Changed?

### Before (Old Pattern)

Services generated keys directly using `crypto`:

```typescript
// ❌ Old way - Duplicated in multiple services
private generateStellarKeyPair(): { publicKey: string; privateKey: string } {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}
```

### After (New Pattern)

Services use `KeyManagementService`:

```typescript
// ✅ New way - Centralized and consistent
constructor(
  private keyManagementService: KeyManagementService,
) {}

async generateKey() {
  const encryptedKeyMaterial = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { purpose: 'wallet', userId: 'user-123' },
  });
  return encryptedKeyMaterial;
}
```

## Migration Steps

### Step 1: Update Imports

Add the key management imports:

```typescript
// Add these imports
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
```

### Step 2: Inject KeyManagementService

Add `KeyManagementService` to your constructor:

```typescript
// Before
constructor(
  private encryptionService: EncryptionService,
  private configService: ConfigService,
) {}

// After
constructor(
  private encryptionService: EncryptionService,
  private configService: ConfigService,
  private keyManagementService: KeyManagementService, // ✅ Add this
) {}
```

### Step 3: Replace Key Generation Code

Replace direct key generation with `KeyManagementService.generateKey()`:

```typescript
// Before ❌
const keyPair = this.generateStellarKeyPair();
const encryptedSecret = this.encryptionService.encryptAndSerialize(keyPair.privateKey);

await this.prisma.wallet.create({
  data: {
    publicKey: keyPair.publicKey,
    encryptedSecret: encryptedSecret,
    // ... other fields
  },
});

// After ✅
const encryptedKeyMaterial = await this.keyManagementService.generateKey({
  keyType: KeyType.STELLAR_ED25519,
  metadata: { userId, network },
});

await this.prisma.wallet.create({
  data: {
    publicKey: encryptedKeyMaterial.publicKey,
    encryptedSecret: encryptedKeyMaterial.encryptedData,
    encryptionVersion: encryptedKeyMaterial.encryptionVersion,
    // ... other fields
  },
});
```

### Step 4: Remove Old Key Generation Methods

Delete your private key generation methods:

```typescript
// ❌ Remove these methods
private generateStellarKeyPair() { ... }
private generateKeyPair() { ... }
private createKeyPair() { ... }
```

### Step 5: Update Module Imports

Add `KeyManagementModule` to your module's imports:

```typescript
// Before
@Module({
  imports: [EncryptionModule, OtherModule],
  providers: [YourService],
})
export class YourModule {}

// After
@Module({
  imports: [
    EncryptionModule,
    OtherModule,
    KeyManagementModule, // ✅ Add this
  ],
  providers: [YourService],
})
export class YourModule {}
```

### Step 6: Update Tests

Update your tests to mock `KeyManagementService`:

```typescript
// Add mock
const mockKeyManagementService = {
  generateKey: jest.fn(),
  sign: jest.fn(),
  validateKey: jest.fn(),
  getAuditLog: jest.fn(),
};

// Add to test module
const module: TestingModule = await Test.createTestingModule({
  providers: [
    YourService,
    {
      provide: KeyManagementService,
      useValue: mockKeyManagementService, // ✅ Add this
    },
    // ... other providers
  ],
}).compile();

// Mock return values
mockKeyManagementService.generateKey.mockResolvedValue({
  encryptedData: 'encrypted-test-key',
  encryptionVersion: 1,
  keyType: KeyType.STELLAR_ED25519,
  publicKey: 'GTEST123...',
});
```

## Common Migration Patterns

### Pattern 1: Wallet Creation

```typescript
// Before ❌
async createWallet(userId: string) {
  const keyPair = this.generateStellarKeyPair();
  const encrypted = this.encryptionService.encryptAndSerialize(keyPair.privateKey);
  
  return {
    publicKey: keyPair.publicKey,
    encryptedSecret: encrypted,
    privateKey: keyPair.privateKey, // Returned for immediate use
  };
}

// After ✅
async createWallet(userId: string) {
  const encryptedKeyMaterial = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { userId, operation: 'create_wallet' },
  });
  
  // Temporarily decrypt if needed for immediate return
  const privateKey = this.encryptionService.deserializeAndDecrypt(
    encryptedKeyMaterial.encryptedData,
  );
  
  return {
    publicKey: encryptedKeyMaterial.publicKey,
    encryptedSecret: encryptedKeyMaterial.encryptedData,
    privateKey, // Only for immediate use
  };
}
```

### Pattern 2: Key Rotation

```typescript
// Before ❌
async rotateKey(walletId: string) {
  const newKeyPair = this.generateStellarKeyPair();
  const encrypted = this.encryptionService.encryptAndSerialize(newKeyPair.privateKey);
  
  await this.updateWallet(walletId, {
    publicKey: newKeyPair.publicKey,
    encryptedSecret: encrypted,
  });
}

// After ✅
async rotateKey(walletId: string) {
  const encryptedKeyMaterial = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { walletId, operation: 'rotation' },
  });
  
  await this.updateWallet(walletId, {
    publicKey: encryptedKeyMaterial.publicKey,
    encryptedSecret: encryptedKeyMaterial.encryptedData,
    encryptionVersion: encryptedKeyMaterial.encryptionVersion,
  });
}
```

### Pattern 3: Batch Key Generation

```typescript
// Before ❌
async createMultipleWallets(userIds: string[]) {
  return Promise.all(
    userIds.map(userId => {
      const keyPair = this.generateStellarKeyPair();
      const encrypted = this.encryptionService.encryptAndSerialize(keyPair.privateKey);
      return { userId, publicKey: keyPair.publicKey, encrypted };
    })
  );
}

// After ✅
async createMultipleWallets(userIds: string[]) {
  return Promise.all(
    userIds.map(async userId => {
      const encryptedKeyMaterial = await this.keyManagementService.generateKey({
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId, batch: true },
      });
      return { 
        userId, 
        publicKey: encryptedKeyMaterial.publicKey, 
        encrypted: encryptedKeyMaterial.encryptedData,
      };
    })
  );
}
```

## Handling Edge Cases

### Case 1: Custom Key Formats

If you need a specific key format:

```typescript
// The provider handles format internally
const encryptedKeyMaterial = await this.keyManagementService.generateKey({
  keyType: KeyType.STELLAR_ED25519,
  metadata: { format: 'custom' }, // Pass as metadata
});

// If you need to transform the key, do it AFTER encryption
// Never transform the private key before encryption
```

### Case 2: Testing with Real Keys

For integration tests that need real keys:

```typescript
// Don't mock KeyManagementService in integration tests
const module: TestingModule = await Test.createTestingModule({
  providers: [
    YourService,
    KeyManagementService, // Real service
    EncryptionService,     // Real service
    ConfigService,         // With real config
  ],
}).compile();

// Keys will be generated for real in tests
```

### Case 3: Existing Encrypted Keys

If you have existing encrypted keys in your database:

```typescript
// They remain compatible - no re-encryption needed
// The new system uses the same EncryptionService

// You can validate them:
const isValid = await this.keyManagementService.validateKey(
  wallet.publicKey,
  wallet.encryptedSecret,
  KeyType.STELLAR_ED25519,
);
```

## Troubleshooting

### Issue: "No provider registered for key type"

**Cause:** The key type is not supported or provider not registered.

**Solution:**
```typescript
// Make sure you're using a supported KeyType
import { KeyType } from '../key-management/domain/key-types';

// Use one of:
KeyType.STELLAR_ED25519
KeyType.ETHEREUM_SECP256K1 // If available
```

### Issue: Tests failing with "Cannot find module 'KeyManagementService'"

**Cause:** Module not imported in test.

**Solution:**
```typescript
// Add to test module providers
{
  provide: KeyManagementService,
  useValue: mockKeyManagementService,
}
```

### Issue: "Private key not returned"

**Cause:** By design - KeyManagementService never returns private keys.

**Solution:**
```typescript
// If you need the private key temporarily (only during creation):
const privateKey = this.encryptionService.deserializeAndDecrypt(
  encryptedKeyMaterial.encryptedData,
);

// Use immediately, don't store
```

### Issue: Circular dependency

**Cause:** Module importing itself.

**Solution:**
```typescript
// Don't import KeyManagementModule in EncryptionModule
// KeyManagementModule imports EncryptionModule, not the other way around
```

## Verification Checklist

After migration, verify:

- [ ] No direct `crypto.generateKeyPairSync()` calls remain
- [ ] All services inject `KeyManagementService`
- [ ] All modules import `KeyManagementModule`
- [ ] All tests mock `KeyManagementService`
- [ ] No private key generation methods remain
- [ ] Integration tests pass
- [ ] Unit tests pass
- [ ] Audit logs show key operations
- [ ] No plaintext private keys are logged
- [ ] Database only contains encrypted keys

## Testing Your Migration

### 1. Run Unit Tests

```bash
npm test -- --testPathPattern=your-service.spec.ts
```

### 2. Run Integration Tests

```bash
npm test -- --testPathPattern=integration.spec.ts
```

### 3. Verify Audit Logs

```typescript
const auditLog = keyManagementService.getAuditLog(10);
console.log(auditLog);

// Should show GENERATE operations with success: true
```

### 4. Check for Security Issues

```bash
# Search for any remaining direct key generation
grep -r "generateKeyPairSync" src/

# Should return no results in your service files
```

## Getting Help

### Common Questions

**Q: Can I still use the old pattern temporarily?**
A: Not recommended. Migrate as soon as possible for consistency and security.

**Q: What happens to existing keys in the database?**
A: They remain valid. The encryption format hasn't changed.

**Q: Do I need to regenerate all keys?**
A: No. Existing keys are compatible.

**Q: Can I use multiple key providers?**
A: Yes. Specify different `KeyType` values for different providers.

### Resources

- [Key Management README](../src/key-management/README.md)
- [Consolidation Documentation](./key-management-consolidation.md)
- [Integration Tests](../src/wallets/wallets-keygen-integration.spec.ts)

## Example Pull Request

Here's a sample PR description for your migration:

```markdown
## Migrate to Consolidated KeyManagementService

### Changes
- Replaced direct `crypto` key generation with `KeyManagementService`
- Added `KeyManagementModule` import to module
- Updated constructor to inject `KeyManagementService`
- Updated tests to mock `KeyManagementService`
- Removed private key generation methods

### Benefits
- Centralized key generation for consistency
- Automatic audit logging
- Provider abstraction for future HSM/KMS support
- Better security through single point of control

### Testing
- ✅ All unit tests pass
- ✅ All integration tests pass
- ✅ Audit logs show key operations
- ✅ No plaintext keys in logs or database

### Breaking Changes
None - API remains the same, implementation changed internally
```

## Timeline

Recommended migration timeline:

1. **Week 1**: Update WalletsService and WalletCreationOrchestrator (✅ Done)
2. **Week 2**: Update other services that generate keys
3. **Week 3**: Remove old key generation utilities
4. **Week 4**: Final verification and documentation updates

## Next Steps

After completing your migration:

1. Review the [Key Management README](../src/key-management/README.md)
2. Set up monitoring for audit logs
3. Consider implementing key rotation policies
4. Plan for HSM/KMS integration if needed
5. Document any custom key handling patterns

## Contact

For questions or issues during migration:
- File an issue in the repository
- Contact the security team
- Review existing PRs that completed migration
