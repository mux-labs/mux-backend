# Key Management Consolidation - Migration Guide

## Overview

This guide helps developers update their code to use the consolidated `KeyManagementService` instead of direct key generation.

> **Related docs:** This guide is the developer-facing companion to the
> [Key Management Migration Runbook](./migration-recovery-runbook.md) (operational
> cutover, rollback, and recovery) and the
> [Custody Security Model](./custody-security-model.md) (threat model and
> invariants). Read all three before touching the key migration path.

## Key Migration Invariants

These invariants are non-negotiable for the key migration path. Any change that
violates one of them must be rejected in review.

1. **Server is the source of truth.** Key material is generated, encrypted, and
   versioned server-side only. Clients never supply or receive raw private key
   material except for the single immediate-use case documented below.
2. **Fail-closed on decrypt.** If decryption, version resolution, or KMS access
   fails, the operation aborts. Never fall back to plaintext, an older key
   version, or a default key.
3. **Versioned envelopes.** Every persisted key records its
   `encryptionVersion`. Migration never rewrites a stored envelope in place
   without recording the new version.
4. **Idempotent migration.** Re-running a migration step for an already-migrated
   key is a no-op keyed by `(walletId, encryptionVersion)`; replays must not
   double-rotate or double-spend.
5. **Deny-by-default authz.** Every migration entrypoint enforces
   owner/delegate/guardian/API-key/JWT policy. A revoked delegate or expired
   token cannot complete a migration step.
6. **No secrets in logs.** Logs, metrics, and error envelopes carry correlation
   ids and stable error codes only — never raw keys, JWTs, or webhook secrets.

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

**Fix:** Ensure the key type is registered in the `KeyManagementModule`
providers and that the module is imported where the service is used.

### Issue: "Decryption failed" / "Unsupported encryption version"

**Cause:** The stored envelope's `encryptionVersion` is not resolvable by the
current key set, or the ciphertext is corrupt.

**Fix:** This is a **fail-closed** condition — do not retry with a fallback key.
Verify the KMS key set includes the version recorded on the wallet, then follow
the [Key Management Migration Runbook](./migration-recovery-runbook.md) for
recovery. Never log the ciphertext or key material while diagnosing.

### Issue: "Unauthorized" during migration

**Cause:** The caller's owner/delegate/guardian/API-key/JWT policy does not
permit the migration step, or the delegate was revoked / token expired.

**Fix:** Re-authenticate with a principal that holds the required role. Do not
add bypass paths — migration entrypoints are deny-by-default.
