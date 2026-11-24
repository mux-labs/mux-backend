import { randomBytes } from 'crypto';

// The repo's Jest setup cannot load the ESM-only dependency of
// @stellar/stellar-sdk v17; use the declared CJS stellar-sdk at runtime while
// still exercising the service's real Keypair signing path.
jest.mock('@stellar/stellar-sdk', () => ({
  Keypair: jest.requireActual('stellar-sdk').Keypair,
}));

import { Keypair } from '@stellar/stellar-sdk';
import { WalletsService } from './wallets.service';

/**
 * Regression coverage for signWithPrivateKey (#1320): it must really sign the
 * 32-byte hash with the Stellar secret, return base64, and fail closed for
 * non-Stellar key material.
 */
describe('WalletsService.signWithPrivateKey', () => {
  const service = new WalletsService({} as any, {} as any, {} as any);
  const sign = (privateKey: string, data: string): string =>
    (service as any).signWithPrivateKey(privateKey, data);

  it('signs a 32-byte hash so the signature verifies with the Stellar public key', () => {
    const keypair = Keypair.fromRawEd25519Seed(randomBytes(32));
    const secret = (keypair as any).secret();
    const publicKey = keypair.publicKey();
    const hash = 'ab'.repeat(32);

    const signature = sign(secret, hash);

    const decoded = Buffer.from(signature, 'base64');
    expect(decoded).toHaveLength(64);
    expect(
      Keypair.fromPublicKey(publicKey).verify(Buffer.from(hash, 'hex'), decoded),
    ).toBe(true);
  });

  it('fails closed for non-Stellar private key material', () => {
    // e.g. hex-encoded PKCS8 material must not be treated as a signing key
    expect(() => sign('00'.repeat(48), 'ab'.repeat(32))).toThrow(
      'Invalid Stellar secret key encoding',
    );
  });
});
