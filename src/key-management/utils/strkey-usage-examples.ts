/**
 * StrKey Helper Usage Examples
 * 
 * This file provides practical examples of using the StrKeyHelper
 * in various scenarios within the Mux Protocol.
 */

import { StrKeyHelper } from './strkey.helper';
import { Keypair } from 'stellar-sdk';
import { Logger } from '@nestjs/common';

const logger = new Logger('StrKeyExamples');

/**
 * Example 1: Validating User-Provided Public Keys
 * 
 * When users provide Stellar addresses, always validate them
 * before storing or using them in transactions.
 */
export function validateUserPublicKey(userProvidedKey: string): boolean {
  // Quick validation
  if (!StrKeyHelper.isValidEd25519PublicKey(userProvidedKey)) {
    logger.warn('Invalid public key provided by user');
    return false;
  }

  // Additional check - ensure it's actually a public key and not a secret
  const keyType = StrKeyHelper.getStrKeyType(userProvidedKey);
  if (keyType.type !== 'publicKey') {
    logger.error('User provided non-public key type:', keyType.type);
    return false;
  }

  logger.log(`Valid public key: ${StrKeyHelper.maskKey(userProvidedKey)}`);
  return true;
}

/**
 * Example 2: Safe Logging of Keys
 * 
 * Always mask keys before logging to prevent accidental exposure.
 */
export function safelyLogKeyOperation(publicKey: string, operation: string): void {
  const masked = StrKeyHelper.maskKey(publicKey);
  logger.log(`${operation} completed for key ${masked}`);
}

/**
 * Example 3: Converting Between Formats
 * 
 * Convert between raw bytes and StrKey format for database storage
 * or API interactions.
 */
export function convertKeyFormats(keypair: Keypair): {
  rawPublicKey: Buffer;
  encodedPublicKey: string;
  rawSecretKey: Buffer;
  encodedSecretSeed: string;
} {
  // Get raw bytes from keypair
  const rawPublicKey = keypair.rawPublicKey();
  const rawSecretKey = keypair.rawSecretKey();

  // Encode to StrKey format
  const encodedPublicKey = StrKeyHelper.encodeEd25519PublicKey(rawPublicKey);
  const encodedSecretSeed = StrKeyHelper.encodeEd25519SecretSeed(rawSecretKey);

  // Verify encoding is correct
  if (encodedPublicKey !== keypair.publicKey()) {
    throw new Error('Public key encoding mismatch');
  }

  if (encodedSecretSeed !== keypair.secret()) {
    throw new Error('Secret seed encoding mismatch');
  }

  return {
    rawPublicKey,
    encodedPublicKey,
    rawSecretKey,
    encodedSecretSeed,
  };
}

/**
 * Example 4: Preventing Secret Seed Exposure
 * 
 * Use quick detection to prevent accidental logging or exposure
 * of secret seeds.
 */
export function preventSecretExposure(value: unknown): void {
  if (StrKeyHelper.looksLikeSecretSeed(value)) {
    logger.error('SECURITY ALERT: Attempted to expose secret seed');
    throw new Error('Cannot expose secret seed');
  }
  
  // Safe to proceed with logging or other operations
  logger.log('Processing non-sensitive value');
}

/**
 * Example 5: Batch Key Validation
 * 
 * Validate multiple keys efficiently and report results.
 */
export function batchValidateKeys(keys: string[]): {
  valid: string[];
  invalid: string[];
  suspicious: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  const suspicious: string[] = [];

  for (const key of keys) {
    const keyType = StrKeyHelper.getStrKeyType(key);

    if (keyType.isValid && keyType.type === 'publicKey') {
      valid.push(key);
    } else if (keyType.type === 'secretSeed') {
      // Flag secret seeds as suspicious
      suspicious.push(StrKeyHelper.maskKey(key));
      logger.warn('Secret seed found in public key list');
    } else {
      invalid.push(key);
    }
  }

  return { valid, invalid, suspicious };
}

/**
 * Example 6: Key Type Detection and Routing
 * 
 * Automatically determine what to do with a key based on its type.
 */
export function routeKeyOperation(key: string): string {
  const keyInfo = StrKeyHelper.getStrKeyType(key);

  switch (keyInfo.type) {
    case 'publicKey':
      return 'Process as account address';
    
    case 'secretSeed':
      return 'ERROR: Secret seeds should not be processed here';
    
    case 'preAuthTx':
      return 'Process as pre-authorized transaction';
    
    case 'sha256Hash':
      return 'Process as hash signer';
    
    case 'muxedAccount':
      return 'Process as muxed account';
    
    case 'contract':
      return 'Process as smart contract';
    
    default:
      return 'Unknown key type';
  }
}

/**
 * Example 7: Working with Pre-Authorized Transactions
 * 
 * Encode and decode transaction hashes for pre-authorization.
 */
export function handlePreAuthTransaction(txHash: Buffer): {
  encoded: string;
  decoded: Buffer;
  isValid: boolean;
} {
  // Encode the transaction hash
  const encoded = StrKeyHelper.encodePreAuthTx(txHash);
  
  // Verify it starts with T
  logger.log(`Pre-auth tx encoded: ${encoded.substring(0, 10)}...`);

  // Decode it back
  const decoded = StrKeyHelper.decodePreAuthTx(encoded);

  // Verify round-trip
  const isValid = decoded.equals(txHash);

  return { encoded, decoded, isValid };
}

/**
 * Example 8: Custom Key Masking for Different Contexts
 * 
 * Use different masking levels based on the logging context.
 */
export function contextualKeyMasking(key: string, context: 'public' | 'internal' | 'audit'): string {
  switch (context) {
    case 'public':
      // Show very little (first 2, last 2)
      return StrKeyHelper.maskKey(key, 2, 2);
    
    case 'internal':
      // Show moderate amount (default: first 4, last 4)
      return StrKeyHelper.maskKey(key);
    
    case 'audit':
      // Show more for audit trail (first 8, last 8)
      return StrKeyHelper.maskKey(key, 8, 8);
    
    default:
      return '***';
  }
}

/**
 * Example 9: Key Validation for API Endpoints
 * 
 * Comprehensive validation for API request parameters.
 */
export function validateAPIKeyParameter(
  key: string | undefined,
  paramName: string,
  expectedType: 'publicKey' | 'any' = 'publicKey',
): { valid: boolean; error?: string } {
  if (!key) {
    return { valid: false, error: `${paramName} is required` };
  }

  if (typeof key !== 'string') {
    return { valid: false, error: `${paramName} must be a string` };
  }

  const keyInfo = StrKeyHelper.getStrKeyType(key);

  if (!keyInfo.isValid) {
    return { valid: false, error: `${paramName} is not a valid Stellar key` };
  }

  if (keyInfo.type === 'secretSeed') {
    logger.error('SECURITY: Secret seed provided in API parameter');
    return { valid: false, error: `${paramName} must not be a secret seed` };
  }

  if (expectedType === 'publicKey' && keyInfo.type !== 'publicKey') {
    return { 
      valid: false, 
      error: `${paramName} must be a public key (starts with G), got ${keyInfo.type}` 
    };
  }

  return { valid: true };
}

/**
 * Example 10: Database Storage Helper
 * 
 * Prepare keys for database storage with validation.
 */
export function prepareKeyForStorage(publicKey: string): {
  publicKey: string;
  publicKeyRaw: Buffer;
  keyType: string;
  isValid: boolean;
} {
  // Validate format
  const isValid = StrKeyHelper.isValidEd25519PublicKey(publicKey);
  
  if (!isValid) {
    throw new Error('Invalid public key format for storage');
  }

  // Decode to raw bytes (optional, for some database schemas)
  const publicKeyRaw = StrKeyHelper.decodeEd25519PublicKey(publicKey);

  // Get type info
  const keyInfo = StrKeyHelper.getStrKeyType(publicKey);

  logger.log(`Storing key: ${StrKeyHelper.maskKey(publicKey)}`);

  return {
    publicKey,
    publicKeyRaw,
    keyType: keyInfo.type,
    isValid,
  };
}

/**
 * Example 11: Migration Helper
 * 
 * Convert keys from one format to another during migrations.
 */
export function migrateKeyFormat(
  oldFormat: { rawBytes: Buffer; keyType: 'public' | 'secret' },
): string {
  try {
    if (oldFormat.keyType === 'public') {
      return StrKeyHelper.encodeEd25519PublicKey(oldFormat.rawBytes);
    } else {
      return StrKeyHelper.encodeEd25519SecretSeed(oldFormat.rawBytes);
    }
  } catch (error) {
    logger.error('Key migration failed:', error);
    throw new Error(`Failed to migrate key: ${error.message}`);
  }
}

/**
 * Example 12: Health Check - Verify Key Infrastructure
 * 
 * Test that key encoding/decoding is working correctly.
 */
export function healthCheckKeyInfrastructure(): {
  healthy: boolean;
  tests: Record<string, boolean>;
  error?: string;
} {
  const tests: Record<string, boolean> = {};

  try {
    // Test 1: Generate a keypair
    const keypair = Keypair.random();
    tests.keypairGeneration = true;

    // Test 2: Encode public key
    const rawPublic = keypair.rawPublicKey();
    const encodedPublic = StrKeyHelper.encodeEd25519PublicKey(rawPublic);
    tests.publicKeyEncoding = encodedPublic === keypair.publicKey();

    // Test 3: Decode public key
    const decodedPublic = StrKeyHelper.decodeEd25519PublicKey(encodedPublic);
    tests.publicKeyDecoding = decodedPublic.equals(rawPublic);

    // Test 4: Validate public key
    tests.publicKeyValidation = StrKeyHelper.isValidEd25519PublicKey(encodedPublic);

    // Test 5: Encode secret seed
    const rawSecret = keypair.rawSecretKey();
    const encodedSecret = StrKeyHelper.encodeEd25519SecretSeed(rawSecret);
    tests.secretSeedEncoding = encodedSecret === keypair.secret();

    // Test 6: Decode secret seed
    const decodedSecret = StrKeyHelper.decodeEd25519SecretSeed(encodedSecret);
    tests.secretSeedDecoding = decodedSecret.equals(rawSecret);

    // Test 7: Validate secret seed
    tests.secretSeedValidation = StrKeyHelper.isValidEd25519SecretSeed(encodedSecret);

    // Test 8: Key type detection
    const publicKeyType = StrKeyHelper.getStrKeyType(encodedPublic);
    const secretKeyType = StrKeyHelper.getStrKeyType(encodedSecret);
    tests.keyTypeDetection = 
      publicKeyType.type === 'publicKey' && 
      secretKeyType.type === 'secretSeed';

    // All tests passed
    const allPassed = Object.values(tests).every((result) => result === true);

    return {
      healthy: allPassed,
      tests,
    };
  } catch (error) {
    return {
      healthy: false,
      tests,
      error: error.message,
    };
  }
}

/**
 * Example 13: Audit Trail with Masked Keys
 * 
 * Create audit log entries with safely masked keys.
 */
export function createAuditEntry(
  operation: string,
  publicKey: string,
  metadata?: Record<string, any>,
): {
  operation: string;
  publicKeyMasked: string;
  timestamp: Date;
  metadata?: Record<string, any>;
} {
  return {
    operation,
    publicKeyMasked: StrKeyHelper.maskKey(publicKey),
    timestamp: new Date(),
    metadata,
  };
}

// Export all examples
export const StrKeyExamples = {
  validateUserPublicKey,
  safelyLogKeyOperation,
  convertKeyFormats,
  preventSecretExposure,
  batchValidateKeys,
  routeKeyOperation,
  handlePreAuthTransaction,
  contextualKeyMasking,
  validateAPIKeyParameter,
  prepareKeyForStorage,
  migrateKeyFormat,
  healthCheckKeyInfrastructure,
  createAuditEntry,
};
