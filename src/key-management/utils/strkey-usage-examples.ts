/**
 * StrKey Helper Usage Examples
 *
 * This file demonstrates practical usage patterns for the StrKeyHelper
 * class in the Mux Protocol key management system.
 */
import { StrKeyHelper, StrKeyType, StrKeyErrorCode } from './strkey.helper';

// ---------------------------------------------------------------------------
// Example 1: Basic public key encoding and validation
// ---------------------------------------------------------------------------

function exampleBasicValidation(): void {
  const helper = new StrKeyHelper();

  // Create a raw 32-byte public key (in practice, this comes from a keypair)
  const rawPublicKey = Buffer.alloc(32);
  rawPublicKey.fill(0x01);

  // Encode to StrKey format
  const encoded = helper.encodeEd25519PublicKey(rawPublicKey);
  console.log(`Encoded public key: ${encoded}`);
  // Output: Encoded public key: GABC... (56 characters)

  // Validate the encoded key
  const isValid = helper.isValidEd25519PublicKey(encoded);
  console.log(`Is valid: ${isValid}`);
  // Output: Is valid: true
}

// ---------------------------------------------------------------------------
// Example 2: Decoding and round-trip verification
// ---------------------------------------------------------------------------

function exampleRoundTrip(): void {
  const helper = new StrKeyHelper();

  const originalBuffer = Buffer.alloc(32);
  originalBuffer.fill(0x42);

  // Encode
  const encoded = helper.encodeEd25519PublicKey(originalBuffer);

  // Decode
  const decoded = helper.decodeEd25519PublicKey(encoded);

  // Verify round-trip
  const roundTripOk = decoded.equals(originalBuffer);
  console.log(`Round-trip successful: ${roundTripOk}`);
  // Output: Round-trip successful: true
}

// ---------------------------------------------------------------------------
// Example 3: Type detection
// ---------------------------------------------------------------------------

function exampleTypeDetection(): void {
  const helper = new StrKeyHelper();

  const publicKey = helper.encodeEd25519PublicKey(Buffer.alloc(32).fill(0x01));
  const secretSeed = helper.encodeEd25519SecretSeed(Buffer.alloc(32).fill(0x02));

  const pkInfo = helper.getStrKeyType(publicKey);
  const ssInfo = helper.getStrKeyType(secretSeed);

  console.log(`Public key type: ${pkInfo.type}, valid: ${pkInfo.isValid}`);
  // Output: Public key type: ed25519PublicKey, valid: true

  console.log(`Secret seed type: ${ssInfo.type}, valid: ${ssInfo.isValid}`);
  // Output: Secret seed type: ed25519SecretSeed, valid: true
}

// ---------------------------------------------------------------------------
// Example 4: Safe logging with masking
// ---------------------------------------------------------------------------

function exampleSafeLogging(): void {
  const helper = new StrKeyHelper();

  const publicKey = helper.encodeEd25519PublicKey(Buffer.alloc(32).fill(0x01));
  const secretSeed = helper.encodeEd25519SecretSeed(Buffer.alloc(32).fill(0x02));

  // NEVER log the full secret seed
  console.log(`Generated public key: ${helper.maskKey(publicKey)}`);
  // Output: Generated public key: GABC********************XYZ9

  // Check before logging if something looks like a secret
  if (helper.looksLikeSecretSeed(secretSeed)) {
    console.log(`Secret seed detected, masking: ${helper.maskKey(secretSeed)}`);
    // Output: Secret seed detected, masking: SABC********************XYZ9
  }
}

// ---------------------------------------------------------------------------
// Example 5: Batch validation
// ---------------------------------------------------------------------------

function exampleBatchValidation(): void {
  const helper = new StrKeyHelper();

  const keys = [
    helper.encodeEd25519PublicKey(Buffer.alloc(32).fill(0x01)),
    helper.encodeEd25519PublicKey(Buffer.alloc(32).fill(0x02)),
    'invalid-key',
    'GABC', // too short
    '',
  ];

  const results = keys.map((key) => ({
    key: helper.maskKey(key),
    valid: helper.isValidEd25519PublicKey(key),
  }));

  for (const result of results) {
    console.log(`${result.key}: valid=${result.valid}`);
  }
  // Output:
  // GABC********************XYZ9: valid=true
  // GABC********************XYZ9: valid=true
  // [INVALID]: valid=false
  // [REDACTED]: valid=false
  // [INVALID]: valid=false
}

// ---------------------------------------------------------------------------
// Example 6: Pre-authorized transaction and SHA256 hash encoding
// ---------------------------------------------------------------------------

function examplePreAuthAndSha256(): void {
  const helper = new StrKeyHelper();

  // Encode a transaction hash for pre-authorized transactions
  const txHash = Buffer.alloc(32);
  txHash.fill(0xAA);
  const preAuthTx = helper.encodePreAuthTx(txHash);
  console.log(`Pre-auth tx: ${preAuthTx}`);

  // Encode a SHA256 hash
  const sha256Hash = Buffer.alloc(32);
  sha256Hash.fill(0xBB);
  const encodedHash = helper.encodeSha256Hash(sha256Hash);
  console.log(`SHA256 hash: ${encodedHash}`);

  // Validate them
  console.log(
    `Pre-auth tx valid: ${helper.isValidPreAuthTx(preAuthTx)}`,
  );
  console.log(
    `SHA256 hash valid: ${helper.isValidSha256Hash(encodedHash)}`,
  );
}

// ---------------------------------------------------------------------------
// Example 7: Error handling with stable error codes
// ---------------------------------------------------------------------------

function exampleErrorHandling(): void {
  const helper = new StrKeyHelper();

  try {
    // Attempt to encode invalid input
    helper.encodeEd25519PublicKey(Buffer.alloc(16) as any);
  } catch (error: any) {
    console.log(`Error: ${error.message}`);
    // Error message contains the stable error code but NOT the raw key
  }

  // Validation methods never throw — they return false
  const isValid = helper.isValidEd25519PublicKey(123 as any);
  console.log(`Validation of non-string input: ${isValid}`);
  // Output: Validation of non-string input: false
}

// ---------------------------------------------------------------------------
// Example 8: Integration with key management workflow
// ---------------------------------------------------------------------------

async function exampleKeyManagementWorkflow(): Promise<void> {
  const helper = new StrKeyHelper();

  // Simulate key generation
  const publicKeyBuffer = Buffer.alloc(32);
  publicKeyBuffer.fill(0x01);

  const secretSeedBuffer = Buffer.alloc(32);
  secretSeedBuffer.fill(0x02);

  // Encode to StrKey format for storage/transmission
  const publicKey = helper.encodeEd25519PublicKey(publicKeyBuffer);
  const secretSeed = helper.encodeEd25519SecretSeed(secretSeedBuffer);

  // Validate before using
  if (!helper.isValidEd25519PublicKey(publicKey)) {
    throw new Error('Invalid public key');
  }

  if (!helper.isValidEd25519SecretSeed(secretSeed)) {
    throw new Error('Invalid secret seed');
  }

  // Decode for use in signing operations
  const decodedPublicKey = helper.decodeEd25519PublicKey(publicKey);

  // Log safely (never log the secret seed)
  console.log(
    `Key generated: publicKey=${helper.maskKey(publicKey)}`,
  );

  // Type check
  const info = helper.getStrKeyType(publicKey);
  console.log(`Key type: ${info.type}`);
}

// ---------------------------------------------------------------------------
// Export examples for documentation
// ---------------------------------------------------------------------------

export {
  exampleBasicValidation,
  exampleRoundTrip,
  exampleTypeDetection,
  exampleSafeLogging,
  exampleBatchValidation,
  examplePreAuthAndSha256,
  exampleErrorHandling,
  exampleKeyManagementWorkflow,
};
