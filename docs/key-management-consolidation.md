# Key Management Consolidation

## Overview

The key generation functionality has been consolidated from `WalletsService` and `WalletCreationOrchestrator` into the centralized `KeyManagementService`. This consolidation provides:

1. **Single Source of Truth**: All key generation goes through one service
2. **Consistent Security**: Uniform key generation, encryption, and audit logging
3. **Easier Maintenance**: Updates to key generation logic only need to happen in one place
4. **Better Audit Trail**: Centralized tracking of all key operations
5. **Provider Abstraction**: Easy to swap key providers (HSM, KMS, etc.)

## Architecture

### Before Consolidation

```
WalletsService
  └─ generateStellarKeyPair() ❌ Duplicated logic
  └─ Uses crypto directly

WalletCreationOrchestrator
  └─ generateStellarKeyPair() ❌ Duplicated logic
  └─ Uses crypto directly
```

### After Consolidation

```
WalletsService
  └─ Uses KeyManagementService.generateKey() ✅

WalletCreationOrchestrator
  └─ Uses KeyManagementService.generateKey() ✅

KeyManagementService (Single Source)
  ├─ generateKey()
  ├─ sign()
  ├─ validateKey()
  └─ Audit logging
  └─ Provider abstraction (StellarKeyProvider, etc.)
```

## Key Changes

### 1. WalletsService

**Before:**
```typescript
private generateStellarKeyPair(): { publicKey: string; privateKey: string } {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
    privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
  };
}
```

**After:**
```typescript
// Constructor now injects KeyManagementService
constructor(
  private encryptionService: EncryptionService,
  private configService: ConfigService,
  private keyManagementService: KeyManagementService, // ✅ New dependency
) {}

// Key generation now uses centralized service
const encryptedKeyMaterial = await this.keyManagementService.generateKey({
  keyType: KeyType.STELLAR_ED25519,
  metadata: { userId, network },
});
```

### 2. WalletCreationOrchestrator

**Before:**
```typescript
private generateStellarKeyPair(): { publicKey: string; privateKey: string } {
  const privateKey = crypto.randomBytes(32).toString('hex');
  const publicKey = `G${crypto.randomBytes(32).toString('hex').toUpperCase()}`;
  return { publicKey, privateKey };
}
```

**After:**
```typescript
// Constructor now injects KeyManagementService
constructor(
  private encryptionService: EncryptionService,
  private configService: ConfigService,
  private idempotentUserService: IdempotentUserService,
  private keyManagementService: KeyManagementService, // ✅ New dependency
) {}

// Key generation now uses centralized service
const encryptedKeyMaterial = await this.keyManagementService.generateKey({
  keyType: KeyType.STELLAR_ED25519,
  metadata: { userId: request.userId, network: request.network },
});
```

### 3. Module Dependencies

**WalletsModule** now imports `KeyManagementModule`:

```typescript
@Module({
  imports: [
    EncryptionModule,
    ApiKeyModule,
    RateLimitModule,
    KeyManagementModule, // ✅ New import
  ],
  controllers: [WalletsController],
  providers: [WalletsService, WalletCreationOrchestrator, EncryptionService],
  exports: [WalletsService, WalletCreationOrchestrator],
})
export class WalletsModule {}
```

## Benefits

### 1. Consistent Key Generation

All wallets now use the same key generation logic through `StellarKeyProvider`:
- Proper Ed25519 key generation using `stellar-sdk`
- Consistent key format and encoding
- Immediate encryption of private keys

### 2. Audit Trail

Every key generation is automatically logged:

```typescript
{
  operation: 'GENERATE',
  keyId: 'new',
  publicKey: 'GABC...',
  timestamp: Date,
  success: true,
  metadata: { userId: 'user-123', network: 'TESTNET' }
}
```

### 3. Provider Abstraction

Easy to swap key providers for different blockchains or security requirements:

```typescript
// Stellar keys
keyManagementService.generateKey({ keyType: KeyType.STELLAR_ED25519 });

// Future: Ethereum keys
keyManagementService.generateKey({ keyType: KeyType.ETHEREUM_SECP256K1 });

// Future: HSM-backed keys
keyManagementService.generateKey({ 
  keyType: KeyType.STELLAR_ED25519,
  provider: 'HSM'
});
```

### 4. Security Properties

All keys benefit from centralized security controls:
- Private keys are NEVER returned from KeyManagementService
- Private keys are NEVER logged
- All key operations are audited
- Keys are encrypted immediately after generation
- Graceful handling of invalid/disconnected states

## Migration Guide

### For New Services

When creating a new service that needs key generation:

```typescript
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';

@Injectable()
export class YourNewService {
  constructor(
    private keyManagementService: KeyManagementService,
  ) {}

  async createNewKey() {
    const encryptedKeyMaterial = await this.keyManagementService.generateKey({
      keyType: KeyType.STELLAR_ED25519,
      metadata: { /* your metadata */ },
    });
    
    // Use encryptedKeyMaterial.publicKey for storage
    // Use encryptedKeyMaterial.encryptedData for encrypted private key storage
  }
}
```

### For Existing Code

If you have existing key generation code:

1. Add `KeyManagementService` to constructor dependencies
2. Replace direct `crypto` calls with `keyManagementService.generateKey()`
3. Update module imports to include `KeyManagementModule`
4. Update tests to mock `KeyManagementService`

## Testing

### Unit Tests

Services now mock `KeyManagementService`:

```typescript
const mockKeyManagementService = {
  generateKey: jest.fn().mockResolvedValue({
    encryptedData: 'encrypted-secret',
    encryptionVersion: 1,
    keyType: KeyType.STELLAR_ED25519,
    publicKey: 'GABC123...',
  }),
};
```

### Integration Tests

Integration tests verify the end-to-end flow:
- See `src/wallets/wallets-keygen-integration.spec.ts`
- Tests verify `KeyManagementService.generateKey()` is called correctly
- Tests verify audit logs are created
- Tests verify error handling

## Future Enhancements

### HSM/KMS Integration

The provider pattern makes it easy to add HSM or KMS support:

```typescript
// Example: AWS KMS provider
class AwsKmsKeyProvider implements IKeyProvider {
  async generateKeyPair(keyType: KeyType): Promise<GeneratedKeyPair> {
    // Call AWS KMS to generate key
  }
}

// Register in KeyManagementService
this.providers.set(KeyType.STELLAR_ED25519_KMS, new AwsKmsKeyProvider());
```

### Multi-Chain Support

Add providers for other blockchains:

```typescript
// Ethereum provider
class EthereumKeyProvider implements IKeyProvider {
  async generateKeyPair(keyType: KeyType): Promise<GeneratedKeyPair> {
    // Generate secp256k1 key for Ethereum
  }
}

// Register
this.providers.set(KeyType.ETHEREUM_SECP256K1, new EthereumKeyProvider());
```

### Key Rotation

Centralized key rotation across all wallets:

```typescript
async rotateAllKeys(reason: string): Promise<RotationSummary> {
  // Iterate through all wallets
  // Generate new keys using KeyManagementService
  // Update all wallet records atomically
}
```

## References

- `src/key-management/key-management.service.ts` - Core service
- `src/key-management/providers/stellar-key.provider.ts` - Stellar implementation
- `src/key-management/interfaces/key-provider.interface.ts` - Provider interface
- `src/wallets/wallets.service.ts` - Example usage
- `src/wallets/wallet-creation-orchestrator.service.ts` - Example usage
- `src/wallets/wallets-keygen-integration.spec.ts` - Integration tests
