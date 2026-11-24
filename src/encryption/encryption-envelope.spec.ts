import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';

import {
  DecryptionError,
  EncryptionResult,
  EncryptionService,
  MIN_ENCRYPTION_KEY_LENGTH,
} from './encryption.service';

/**
 * Regression tests for the `EncryptionResult` envelope contract (issue #1332):
 *
 *   AES-256-GCM ciphertext envelope as persisted in `Wallet.encryptedSecret`.
 *   The envelope is self-describing: `iv` and `tag` travel with the ciphertext
 *   so decryption needs nothing but the master key.
 */

const MASTER_KEY = 'm'.repeat(MIN_ENCRYPTION_KEY_LENGTH);
const OTHER_KEY = 'o'.repeat(MIN_ENCRYPTION_KEY_LENGTH);
const SECRET = 'SABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMN';
const IV_HEX_LENGTH = 32; // 128-bit IV
const TAG_HEX_LENGTH = 32; // 128-bit GCM tag

const serviceWithKey = (key: string): EncryptionService =>
  new EncryptionService({
    get: (name: string) => (name === 'WALLET_ENCRYPTION_KEY' ? key : undefined),
  } as unknown as ConfigService);

/** Builds the `Wallet.encryptedSecret` column value exactly as persisted. */
const persist = (service: EncryptionService, plaintext: string): string =>
  service.encryptAndSerialize(plaintext);

const expectDecryptionError = (fn: () => unknown, code: string): void => {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DecryptionError);
  expect((caught as DecryptionError).code).toBe(code);
};

describe('EncryptionResult envelope (#1332)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  describe('shape as persisted in Wallet.encryptedSecret', () => {
    it('serializes to JSON carrying exactly encryptedData, iv and tag', () => {
      const stored = persist(serviceWithKey(MASTER_KEY), SECRET);
      const parsed = JSON.parse(stored) as Record<string, unknown>;

      expect(Object.keys(parsed).sort()).toEqual(
        ['encryptedData', 'iv', 'tag'].sort(),
      );
    });

    it('hex-encodes a 128-bit iv and a 128-bit GCM tag', () => {
      const envelope = serviceWithKey(MASTER_KEY).encrypt(SECRET);

      expect(envelope.iv).toMatch(new RegExp(`^[0-9a-f]{${IV_HEX_LENGTH}}$`));
      expect(envelope.tag).toMatch(new RegExp(`^[0-9a-f]{${TAG_HEX_LENGTH}}$`));
      expect(envelope.encryptedData).toMatch(/^[0-9a-f]+$/);
    });

    it('never persists the plaintext or the master key', () => {
      const stored = persist(serviceWithKey(MASTER_KEY), SECRET);

      expect(stored).not.toContain(SECRET);
      expect(stored).not.toContain(MASTER_KEY);
    });

    it('is genuine AES-256-GCM keyed by SHA-256(master key)', () => {
      const envelope = serviceWithKey(MASTER_KEY).encrypt(SECRET);

      // Independent decryption with only the envelope fields + master key.
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        crypto.createHash('sha256').update(MASTER_KEY).digest(),
        Buffer.from(envelope.iv, 'hex'),
      );
      decipher.setAAD(Buffer.from('wallet-secret', 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      const plaintext =
        decipher.update(envelope.encryptedData, 'hex', 'utf8') +
        decipher.final('utf8');

      expect(plaintext).toBe(SECRET);
    });
  });

  describe('self-describing: decryption needs nothing but the master key', () => {
    it('decrypts in a fresh service instance that shares only the master key', () => {
      const stored = persist(serviceWithKey(MASTER_KEY), SECRET);

      // A brand new instance has no state from the encrypting instance.
      const reader = serviceWithKey(MASTER_KEY);

      expect(reader.deserializeAndDecrypt(stored)).toBe(SECRET);
    });

    it('round-trips through a plain JSON copy of the envelope', () => {
      const envelope = serviceWithKey(MASTER_KEY).encrypt(SECRET);
      const copy = JSON.parse(JSON.stringify(envelope)) as EncryptionResult;

      expect(serviceWithKey(MASTER_KEY).decrypt(copy)).toBe(SECRET);
    });

    it('carries a per-envelope iv, so each envelope decrypts independently', () => {
      const writer = serviceWithKey(MASTER_KEY);
      const first = writer.encrypt(SECRET);
      const second = writer.encrypt(SECRET);

      expect(first.iv).not.toBe(second.iv);

      const reader = serviceWithKey(MASTER_KEY);
      expect(reader.decrypt(first)).toBe(SECRET);
      expect(reader.decrypt(second)).toBe(SECRET);
    });
  });

  describe('fail closed when the envelope or key is incomplete', () => {
    it.each(['encryptedData', 'iv', 'tag'] as const)(
      'rejects a stored envelope missing %s with INVALID_DATA',
      (field) => {
        const service = serviceWithKey(MASTER_KEY);
        const envelope = JSON.parse(persist(service, SECRET)) as Record<
          string,
          unknown
        >;
        delete envelope[field];

        expectDecryptionError(
          () => service.deserializeAndDecrypt(JSON.stringify(envelope)),
          'INVALID_DATA',
        );
      },
    );

    it('rejects a stored envelope with a truncated iv with INVALID_DATA', () => {
      const service = serviceWithKey(MASTER_KEY);
      const envelope = service.encrypt(SECRET);

      expectDecryptionError(
        () =>
          service.deserializeAndDecrypt(
            JSON.stringify({ ...envelope, iv: envelope.iv.slice(0, 24) }),
          ),
        'INVALID_DATA',
      );
    });

    it('cannot decrypt with an iv taken from another envelope', () => {
      const service = serviceWithKey(MASTER_KEY);
      const envelope = service.encrypt(SECRET);
      const other = service.encrypt(SECRET);

      expectDecryptionError(
        () => service.decrypt({ ...envelope, iv: other.iv }),
        'DECRYPTION_FAILED',
      );
    });

    it('cannot decrypt with a tag taken from another envelope', () => {
      const service = serviceWithKey(MASTER_KEY);
      const envelope = service.encrypt(SECRET);
      const other = service.encrypt(SECRET);

      expectDecryptionError(
        () => service.decrypt({ ...envelope, tag: other.tag }),
        'DECRYPTION_FAILED',
      );
    });

    it('cannot decrypt without the right master key', () => {
      const stored = persist(serviceWithKey(MASTER_KEY), SECRET);

      expectDecryptionError(
        () => serviceWithKey(OTHER_KEY).deserializeAndDecrypt(stored),
        'DECRYPTION_FAILED',
      );
    });
  });
});
