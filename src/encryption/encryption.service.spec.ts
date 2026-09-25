import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  EncryptionService,
  DecryptionError,
  MIN_ENCRYPTION_KEY_LENGTH,
  PLACEHOLDER_ENCRYPTION_KEYS,
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

  describe('self test', () => {
    it('validates a working configuration', async () => {
      const service = await build({ WALLET_ENCRYPTION_KEY: GOOD_KEY });
      expect(service.validateConfiguration()).toBe(true);
    });
  });
});
