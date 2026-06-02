# Key Management Module

## Overview

The Key Management Module provides a secure, centralized service for cryptographic key operations in the Mux Protocol. This module is the **ONLY** layer that has access to private keys and ensures they are never exposed outside the service boundary.

## Core Principles

1. **Private keys are NEVER returned** from this service
2. **Private keys are NEVER logged** to any output
3. **All key operations are audited** for security monitoring
4. **Keys are encrypted immediately** after generation
5. **Provider abstraction** allows swapping between implementations (in-memory, HSM, KMS)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│              KeyManagementService                        │
│  (Orchestrates key operations, audit, encryption)       │
└────────────────┬────────────────────────────────────────┘
                 │
         ┌───────┴────────┐
         │                │
    ┌────▼─────┐    ┌────▼─────┐
    │ Stellar  │    │  Future  │
    │ Provider │    │ Providers│
    │ (Ed25519)│    │ (HSM/KMS)│
    └──────────┘    └──────────┘
```

## Key Components

### KeyManagementService

Main service that coordinates all key operations.

**Methods:**
- `generateKey(request)` - Generates and encrypts a new keypair
- `sign(request)` - Signs data without exposing the private key
- `validateKey(...)` - Validates encrypted key material
- `reEncryptKey(...)` - Re-encrypts keys (for rotation or version upgrade)
- `getAuditLog(limit)` - Returns audit trail of key operations
- `getStatistics(query)` - Returns key usage statistics
- `getDetailedStatistics(query)` - Returns detailed statistics with metrics and time series

### IKeyProvider Interface

Abstraction for different key generation implementations.

**Methods:**
- `generateKeyPair(keyType)` - Creates a new keypair
- `sign(encryptedMaterial, data)` - Signs data with encrypted key
- `validateKeyPair(publicKey, encryptedMaterial)` - Validates keypair
- `getProviderName()` - Returns provider identifier

### StellarKeyProvider

Implementation for Stellar blockchain Ed25519 keys.

Uses `stellar-sdk` for proper Stellar key generation and signing.

## Usage

### Generating a New Key

```typescript
import { KeyManagementService } from './key-management/key-management.service';
import { KeyType } from './key-management/domain/key-types';

// Inject the service
constructor(
  private keyManagementService: KeyManagementService,
) {}

// Generate a new key
async createWallet() {
  const encryptedKeyMaterial = await this.keyManagementService.generateKey({
    keyType: KeyType.STELLAR_ED25519,
    metadata: { userId: 'user-123', purpose: 'wallet' },
  });

  // Result contains:
  // - encryptedData: string (encrypted private key)
  // - publicKey: string (Stellar public key)
  // - keyType: KeyType
  // - encryptionVersion: number
  
  // Store encryptedData and publicKey in database
  // NEVER store or return the plaintext private key
}
```

### Signing Data

```typescript
async signTransaction(walletId: string, transactionData: Buffer) {
  // Retrieve encrypted key material from database
  const wallet = await this.getWallet(walletId);
  
  // Sign without ever exposing the private key
  const signature = await this.keyManagementService.sign({
    encryptedKeyMaterial: wallet.encryptedSecret,
    dataToSign: transactionData,
    publicKey: wallet.publicKey,
  });

  // Result contains:
  // - signature: string
  // - publicKey: string
  // - algorithm: string
  // - timestamp: Date
  
  return signature;
}
```

### Validating a Key

```typescript
async validateWalletKey(walletId: string) {
  const wallet = await this.getWallet(walletId);
  
  const isValid = await this.keyManagementService.validateKey(
    wallet.publicKey,
    wallet.encryptedSecret,
    KeyType.STELLAR_ED25519,
  );

  return isValid;
}
```

## Security Features

### Audit Logging

All operations are automatically logged:

```typescript
const auditLog = keyManagementService.getAuditLog(100);
// Returns array of audit entries:
[
  {
    operation: 'GENERATE',
    keyId: 'new',
    publicKey: 'GABC...XYZ',
    timestamp: '2024-01-15T10:30:00Z',
    success: true,
    metadata: { userId: 'user-123' }
  },
  {
    operation: 'SIGN',
    keyId: 'wallet-456',
    publicKey: 'GDEF...ABC',
    timestamp: '2024-01-15T10:31:00Z',
    success: true
  }
]
```

### Encryption Flow

```
1. Generate keypair
   ├─ Create Ed25519 keypair using stellar-sdk
   └─ Private key exists ONLY in memory

2. Encrypt immediately
   ├─ Pass private key to EncryptionService
   ├─ AES-256-GCM encryption with authenticated encryption
   └─ Clear private key from memory

3. Return encrypted material
   ├─ Encrypted data (ciphertext)
   ├─ Public key (plaintext)
   └─ Metadata (encryption version, key type)
```

### Signing Flow

```
1. Receive encrypted key material
   └─ From database or secure storage

2. Temporarily decrypt
   ├─ Decrypt in memory only
   ├─ NEVER log or store plaintext
   └─ Use immediately

3. Sign data
   ├─ Use stellar-sdk signing
   └─ Produce cryptographic signature

4. Clear private key
   └─ Ensure plaintext is cleared from memory

5. Return signature
   └─ Signature + metadata, NO private key
```

## Error Handling

### Graceful Degradation

The service handles various failure states:

```typescript
// Invalid key type
try {
  await keyManagementService.generateKey({ 
    keyType: 'INVALID_TYPE' as KeyType 
  });
} catch (error) {
  // Throws NotFoundException: "No provider registered for key type: INVALID_TYPE"
}

// Decryption failure (corrupted data)
try {
  await keyManagementService.sign({
    encryptedKeyMaterial: 'corrupted-data',
    dataToSign: buffer,
    publicKey: 'GABC...',
  });
} catch (error) {
  // Throws Error: "Signing operation failed"
  // Original error is logged but not exposed
}

// Invalid state (disconnected provider)
// Provider can be in disconnected state
// Service will throw appropriate error without exposing sensitive details
```

## Testing

### Unit Tests

```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { KeyManagementService } from './key-management.service';
import { EncryptionService } from '../encryption/encryption.service';
import { KeyType } from './domain/key-types';

describe('KeyManagementService', () => {
  let service: KeyManagementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeyManagementService,
        EncryptionService,
        ConfigService,
      ],
    }).compile();

    service = module.get<KeyManagementService>(KeyManagementService);
  });

  it('should generate encrypted key without exposing private key', async () => {
    const result = await service.generateKey({
      keyType: KeyType.STELLAR_ED25519,
    });

    expect(result.encryptedData).toBeDefined();
    expect(result.publicKey).toBeDefined();
    expect(result).not.toHaveProperty('privateKey');
    expect(result).not.toHaveProperty('privateKeyMaterial');
  });
});
```

### Integration Tests

See `src/wallets/wallets-keygen-integration.spec.ts` for examples of testing the service with real consumers.

## Adding New Key Providers

### 1. Create Provider Class

```typescript
import { Injectable } from '@nestjs/common';
import { IKeyProvider } from '../interfaces/key-provider.interface';
import { GeneratedKeyPair, SignatureResult, KeyType } from '../domain/key-types';

@Injectable()
export class MyNewKeyProvider implements IKeyProvider {
  async generateKeyPair(keyType: KeyType): Promise<GeneratedKeyPair> {
    // Implement key generation for your blockchain/system
    return {
      publicKey: 'generated-public-key',
      privateKeyMaterial: 'generated-private-key',
      keyType,
      metadata: { algorithm: 'your-algorithm' },
    };
  }

  async sign(
    encryptedKeyMaterial: string,
    dataToSign: Buffer,
  ): Promise<SignatureResult> {
    // Implement signing logic
    return {
      signature: 'signature-data',
      publicKey: 'public-key',
      algorithm: 'your-algorithm',
      timestamp: new Date(),
    };
  }

  async validateKeyPair(
    publicKey: string,
    encryptedKeyMaterial: string,
  ): Promise<boolean> {
    // Implement validation logic
    return true;
  }

  getProviderName(): string {
    return 'MyNewKeyProvider';
  }
}
```

### 2. Register Provider

```typescript
// In KeyManagementService constructor
constructor(
  private readonly encryptionService: EncryptionService,
  private readonly configService: ConfigService,
) {
  this.providers = new Map();

  // Existing providers
  const stellarProvider = new StellarKeyProvider(this.encryptionService);
  this.providers.set(KeyType.STELLAR_ED25519, stellarProvider);

  // Register your new provider
  const myProvider = new MyNewKeyProvider();
  this.providers.set(KeyType.YOUR_NEW_TYPE, myProvider);
}
```

### 3. Add Key Type

```typescript
// In src/key-management/domain/key-types.ts
export enum KeyType {
  STELLAR_ED25519 = 'STELLAR_ED25519',
  ETHEREUM_SECP256K1 = 'ETHEREUM_SECP256K1',
  YOUR_NEW_TYPE = 'YOUR_NEW_TYPE', // Add here
}
```

## Module Configuration

### Module Setup

```typescript
import { Module } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { KeyManagementController } from './key-management.controller';
import { StellarKeyProvider } from './providers/stellar-key.provider';
import { EncryptionModule } from '../encryption/encryption.module';

@Module({
  imports: [EncryptionModule],
  controllers: [KeyManagementController],
  providers: [KeyManagementService, StellarKeyProvider],
  exports: [KeyManagementService], // Export for use in other modules
})
export class KeyManagementModule {}
```

### Importing in Other Modules

```typescript
import { Module } from '@nestjs/common';
import { KeyManagementModule } from '../key-management/key-management.module';
import { YourService } from './your.service';

@Module({
  imports: [KeyManagementModule], // Import the module
  providers: [YourService],
})
export class YourModule {}
```

## Best Practices

### DO ✅

- Use `KeyManagementService` for all key generation
- Store only encrypted key material in databases
- Use the audit log for security monitoring
- Handle errors gracefully without exposing sensitive details
- Test with mocked `KeyManagementService` in unit tests
- Add metadata to help with debugging and audit trails

### DON'T ❌

- Never generate keys directly with `crypto` or other libraries
- Never return plaintext private keys from any service
- Never log private keys or encrypted key material
- Never bypass the key management service
- Never store plaintext private keys in databases
- Never transmit private keys over network in plaintext

## Roadmap

### Planned Features

1. **HSM Integration** - Hardware security module support
2. **KMS Integration** - AWS KMS, Google Cloud KMS support
3. **Key Rotation Automation** - Scheduled key rotation
4. **Multi-Signature Support** - Threshold signatures
5. **Key Derivation** - HD wallet support (BIP32/BIP44)
6. **External Audit Export** - Push audit logs to SIEM systems
7. **Rate Limiting** - Prevent abuse of signing operations
8. **Key Usage Policies** - Time-based or usage-based restrictions

## Support & Maintenance

### Monitoring

Monitor audit logs for:
- Unusual key generation patterns
- Failed signing attempts
- Validation failures
- Rate limit violations

### Alerts

Set up alerts for:
- High failure rates (> 5% of operations)
- Unexpected key types
- Large batches of key generation
- Operations outside business hours

## References

- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Ed25519 Signature Scheme](https://ed25519.cr.yp.to/)
- [NIST Key Management Guidelines](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
