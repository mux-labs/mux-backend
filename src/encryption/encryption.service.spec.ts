import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  EncryptionService,
  DecryptionError,
  MIN_ENCRYPTION_KEY_LENGTH,
  PLACEHOLDER_ENCRYPTION_KEYS,
} from './encryption.service';
import type {
  DecryptionErrorCode,
  EncryptionResult,
} from './encryption.service';

const GOOD_KEY = 'a'.repeat(MIN_ENCRYPTION_KEY_LENGTH);
const OTHER_KEY = 'b'.repeat(MIN_ENCRYPTION_KEY_LENGTH);
const SECRET = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN';

const makeConfig = (env: Record<string, string | undefined>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

async function build(env: Record<string, string | undefined>) {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      EncryptionService,
      { provide: ConfigService, useValue: makeConfig(env) },
    ],
  }).compile();
  return module.get(EncryptionService);
}

describe('EncryptionService', () => {
  describe('boot-time key validation (fail closed)', () => {
    it('is defined for a valid key', async () => {
      await expect(
        build({ WALLET_ENCRYPTION_KEY: GOOD_KEY }),
      ).resolves.toBeDefined();
    });

    it.each([undefined, '', '   '])(
      'refuses to boot when the key is %p',
      async (key) => {
        await expect(build({ WALLET_ENCRYPTION_KEY: key })).rejects.toThrow(
          /is required/,
        );
      },
    );

    it('refuses a key shorter than the documented minimum', async () => {
      await expect(
        build({
          WALLET_ENCRYPTION_KEY: 'a'.repeat(MIN_ENCRYPTION_KEY_LENGTH - 1),
        }),
      ).rejects.toThrow(new RegExp(`at least ${MIN_ENCRYPTION_KEY_LENGTH}`));
    });

    it.each(PLACEHOLDER_ENCRYPTION_KEYS)(
      'refuses the documented placeholder %s',
      async (placeholder) => {
        await expect(
          build({ WALLET_ENCRYPTION_KEY: placeholder }),
        ).rejects.toThrow(/placeholder/);
      },
    );

    it('accepts a key exactly at the minimum length', async () => {
      await expect(
        build({ WALLET_ENCRYPTION_KEY: 'a'.repeat(MIN_ENCRYPTION_KEY_LENGTH) }),
      ).resolves.toBeDefined();
    });
  });

  describe('AES-256-GCM envelope', () => {
    it('round-trips a secret seed', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const stored = service.encryptAndSerialize(SECRET);

      expect(service.deserializeAndDecrypt(stored)).toBe(SECRET);
    });

    it('uses a 128-bit IV and emits a 128-bit auth tag', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const result = service.encrypt(SECRET);

      expect(result.iv).toHaveLength(32); // 16 bytes, hex-encoded
      expect(result.tag).toHaveLength(32); // 16 bytes, hex-encoded
    });

    it('never stores the plaintext in the envelope', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const stored = service.encryptAndSerialize(SECRET);

      expect(stored).not.toContain(SECRET);
    });

    it('uses a fresh IV for every encryption', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const ivs = new Set(
        Array.from({ length: 25 }, () => service.encrypt(SECRET).iv),
      );

      // A repeated IV under one key would leak plaintext structure.
      expect(ivs.size).toBe(25);
    });

    it('produces different ciphertext for the same input', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(service.encrypt(SECRET).encryptedData).not.toBe(
        service.encrypt(SECRET).encryptedData,
      );
    });
  });

  describe('fail-closed decryption (stable error codes)', () => {
    it('rejects a wrong key with DECRYPTION_FAILED', async () => {
      const writer = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const reader = await build({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
      const stored = writer.encryptAndSerialize(SECRET);

      expect(() => reader.deserializeAndDecrypt(stored)).toThrow(
        DecryptionError,
      );
      try {
        reader.deserializeAndDecrypt(stored);
      } catch (e) {
        expect((e as DecryptionError).code).toBe('DECRYPTION_FAILED');
      }
    });

    it('rejects tampered ciphertext', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const result = service.encrypt(SECRET);
      // Flip one hex nibble of the ciphertext.
      const tampered = {
        ...result,
        encryptedData:
          (result.encryptedData[0] === '0' ? '1' : '0') +
          result.encryptedData.slice(1),
      };

      expect(() => service.decrypt(tampered)).toThrow(DecryptionError);
    });

    it('rejects a swapped auth tag (AAD/context binding)', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const a = service.encrypt(SECRET);
      const b = service.encrypt(SECRET);

      // Grafting another envelope's tag must not authenticate.
      expect(() => service.decrypt({ ...a, tag: b.tag })).toThrow(
        DecryptionError,
      );
    });

    it.each([
      ['not json at all', 'INVALID_DATA'],
      ['{"encryptedData":"aa"}', 'INVALID_DATA'],
      ['{"encryptedData":"aa","iv":"bb"}', 'INVALID_DATA'],
      ['{}', 'INVALID_DATA'],
    ])('rejects a malformed envelope (%s) with %s', async (stored, code) => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      try {
        service.deserializeAndDecrypt(stored);
        throw new Error('expected a DecryptionError');
      } catch (e) {
        expect(e).toBeInstanceOf(DecryptionError);
        expect((e as DecryptionError).code).toBe(code);
      }
    });

    it('never returns empty plaintext on failure', async () => {
      const writer = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const reader = await build({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
      const stored = writer.encryptAndSerialize(SECRET);

      // A swallowed failure returning '' would sign with an empty key.
      let result: string | undefined;
      try {
        result = reader.deserializeAndDecrypt(stored);
      } catch {
        result = undefined;
      }
      expect(result).toBeUndefined();
    });

    it('does not leak key material in the error', async () => {
      const writer = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const reader = await build({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
      const stored = writer.encryptAndSerialize(SECRET);

      try {
        reader.deserializeAndDecrypt(stored);
        throw new Error('expected a DecryptionError');
      } catch (e) {
        const serialized = `${(e as Error).message}${(e as DecryptionError).code}`;
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain(GOOD_KEY);
        expect(serialized).not.toContain(OTHER_KEY);
      }
    });
  });

  describe('master-key rotation support', () => {
    it('reports no previous key by default', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(service.hasPreviousKey()).toBe(false);
    });

    it('re-encryption is a no-op under the current key', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const stored = service.encryptAndSerialize(SECRET);

      const result = service.reEncryptWithCurrentKey(stored);
      expect(result.rotated).toBe(false);
      expect(result.data).toBe(stored);
    });

    it('re-wraps ciphertext written under the previous key', async () => {
      const old = await build({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
      const stored = old.encryptAndSerialize(SECRET);

      const rotated = await build({
        WALLET_ENCRYPTION_KEY: GOOD_KEY,
        WALLET_ENCRYPTION_KEY_PREVIOUS: OTHER_KEY,
      });
      expect(rotated.hasPreviousKey()).toBe(true);

      const result = rotated.reEncryptWithCurrentKey(stored);
      expect(result.rotated).toBe(true);
      // Must be readable under the new key only.
      const newKeyOnly = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(newKeyOnly.deserializeAndDecrypt(result.data)).toBe(SECRET);
    });

    it('refuses a previous key identical to the current key', async () => {
      await expect(
        build({
          WALLET_ENCRYPTION_KEY: GOOD_KEY,
          WALLET_ENCRYPTION_KEY_PREVIOUS: GOOD_KEY,
        }),
      ).rejects.toThrow(/must differ/);
    });

    it('refuses a previous key that is too short', async () => {
      await expect(
        build({
          WALLET_ENCRYPTION_KEY: GOOD_KEY,
          WALLET_ENCRYPTION_KEY_PREVIOUS: 'short',
        }),
      ).rejects.toThrow(new RegExp(`at least ${MIN_ENCRYPTION_KEY_LENGTH}`));
    });

    it('fails closed when no previous key is configured', async () => {
      const old = await build({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
      const stored = old.encryptAndSerialize(SECRET);

      const current = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(() => current.reEncryptWithCurrentKey(stored)).toThrow(
        DecryptionError,
      );
    });
  });

  describe('AAD context binding (Buffer.from("wallet-secret"))', () => {
    // Mirror the service's key derivation so the test can act as an
    // independent party holding the same master key but a different context.
    const derivedKey = crypto.createHash('sha256').update(GOOD_KEY).digest();
    const WALLET_AAD = Buffer.from('wallet-secret', 'utf8');

    /** Encrypts `plaintext` under the master key with an arbitrary AAD. */
    const encryptWithAad = (
      plaintext: string,
      aad: Buffer | null,
    ): EncryptionResult => {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
      if (aad) {
        cipher.setAAD(aad);
      }
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return {
        encryptedData: encrypted,
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
      };
    };

    /** Decrypts an envelope under the master key with an arbitrary AAD. */
    const decryptWithAad = (
      envelope: EncryptionResult,
      aad: Buffer | null,
    ): string => {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        derivedKey,
        Buffer.from(envelope.iv, 'hex'),
      );
      if (aad) {
        decipher.setAAD(aad);
      }
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      let decrypted = decipher.update(envelope.encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    };

    const expectDecryptionFailed = (fn: () => unknown): void => {
      try {
        fn();
        throw new Error('expected a DecryptionError');
      } catch (e) {
        expect(e).toBeInstanceOf(DecryptionError);
        expect((e as DecryptionError).code).toBe('DECRYPTION_FAILED');
      }
    };

    it('binds every ciphertext to the fixed "wallet-secret" AAD', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const envelope = service.encrypt(SECRET);

      // Same key, exact documented AAD: authenticates.
      expect(decryptWithAad(envelope, WALLET_AAD)).toBe(SECRET);
    });

    it('fails the GCM tag when the ciphertext is read in a different context', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const envelope = service.encrypt(SECRET);

      // Same key, but a different (or absent) AAD must not authenticate.
      expect(() =>
        decryptWithAad(envelope, Buffer.from('wallet-secret:row-2', 'utf8')),
      ).toThrow(/unable to authenticate/);
      expect(() => decryptWithAad(envelope, null)).toThrow(
        /unable to authenticate/,
      );
    });

    it('accepts ciphertext produced in the wallet-secret context', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });

      expect(service.decrypt(encryptWithAad(SECRET, WALLET_AAD))).toBe(SECRET);
    });

    it.each([
      ['a different AAD', Buffer.from('api-key-secret', 'utf8')],
      ['no AAD at all', null],
    ])(
      'refuses a ciphertext transplanted from %s with DECRYPTION_FAILED',
      async (_label, aad) => {
        const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
        // Valid ciphertext under the *same* master key, minted for another
        // context: only the AAD binding stops it from being accepted.
        const foreign = encryptWithAad(SECRET, aad);

        expectDecryptionFailed(() => service.decrypt(foreign));
        expectDecryptionFailed(() =>
          service.deserializeAndDecrypt(JSON.stringify(foreign)),
        );
      },
    );
  });

  describe('classify (stable decryption error codes)', () => {
    const classify = (service: EncryptionService, error: unknown) =>
      (
        service as unknown as { classify(e: unknown): DecryptionErrorCode }
      ).classify(error);

    it.each([
      'Unsupported state or unable to authenticate data',
      'error:1C800064:Provider routines::bad decrypt',
    ])('maps a GCM auth-tag failure (%s) to DECRYPTION_FAILED', async (msg) => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(classify(service, new Error(msg))).toBe('DECRYPTION_FAILED');
    });

    it('classifies a non-Error auth-tag failure by its string form', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(classify(service, 'bad decrypt')).toBe('DECRYPTION_FAILED');
    });

    it.each(['wrong key', 'bad key length'])(
      'maps a key failure (%s) to INVALID_KEY',
      async (msg) => {
        const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
        expect(classify(service, new Error(msg))).toBe('INVALID_KEY');
      },
    );

    it.each([
      ['an unrelated Error', new Error('Invalid initialization vector')],
      ['a TypeError', new TypeError('The "data" argument must be a string')],
      ['a bare string', 'something odd'],
      ['undefined', undefined],
      ['null', null],
      ['a plain object', { reason: 'nope' }],
    ])('maps anything else (%s) to INVALID_DATA', async (_label, error) => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(classify(service, error)).toBe('INVALID_DATA');
    });

    it('reports a real wrong-key decrypt as DECRYPTION_FAILED (fail closed)', async () => {
      const writer = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      const reader = await build({ WALLET_ENCRYPTION_KEY: OTHER_KEY });
      const envelope = writer.encrypt(SECRET);

      let result: string | undefined;
      let caught: unknown;
      try {
        result = reader.decrypt(envelope);
      } catch (e) {
        caught = e;
      }
      expect(result).toBeUndefined();
      expect(caught).toBeInstanceOf(DecryptionError);
      expect((caught as DecryptionError).code).toBe('DECRYPTION_FAILED');
    });

    it.each([
      ['an empty IV', (e: EncryptionResult) => ({ ...e, iv: '' })],
      [
        'a truncated auth tag',
        (e: EncryptionResult) => ({ ...e, tag: 'abcd' }),
      ],
    ])(
      'reports malformed input (%s) as INVALID_DATA (fail closed)',
      async (_label, corrupt) => {
        const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
        // Bypasses deserializeFromStorage on purpose so the crypto layer
        // itself rejects the envelope and classify decides the code.
        const malformed = corrupt(service.encrypt(SECRET));

        let result: string | undefined;
        let caught: unknown;
        try {
          result = service.decrypt(malformed);
        } catch (e) {
          caught = e;
        }
        expect(result).toBeUndefined();
        expect(caught).toBeInstanceOf(DecryptionError);
        expect((caught as DecryptionError).code).toBe('INVALID_DATA');
      },
    );
  });

  describe('self test', () => {
    it('validates a working configuration', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(service.validateConfiguration()).toBe(true);
    });
  });
});
