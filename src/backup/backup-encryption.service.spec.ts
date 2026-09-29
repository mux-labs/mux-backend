import type { ConfigService } from '@nestjs/config';
import {
  BACKUP_ENCRYPTION_KEY_ENV,
  BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV,
  BACKUP_ENVELOPE_VERSION,
  BackupEncryptionError,
  BackupEncryptionService,
  MIN_BACKUP_KEY_LENGTH,
  PLACEHOLDER_BACKUP_KEYS,
} from './backup-encryption.service';

const ACTIVE_KEY = 'active-backup-key-0123456789abcdef-32chars-min';
const PREVIOUS_KEY = 'previous-backup-key-0123456789abcdef-32chars';
const NEW_KEY = 'rotated-backup-key-0123456789abcdef0123456789';
const PLAINTEXT = 'CREATE DATABASE backup_2026_01_01;';

function config(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

describe('BackupEncryptionService', () => {
  describe('fail-closed boot', () => {
    it('refuses to start without a key', () => {
      expect(() => new BackupEncryptionService(config({}))).toThrow(
        BackupEncryptionError,
      );
      try {
        new BackupEncryptionService(config({}));
      } catch (err) {
        expect((err as BackupEncryptionError).code).toBe(
          'BACKUP_KEY_UNAVAILABLE',
        );
      }
    });

    it('refuses a key shorter than the documented minimum', () => {
      try {
        new BackupEncryptionService(
          config({ [BACKUP_ENCRYPTION_KEY_ENV]: 'short-key' }),
        );
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as BackupEncryptionError).code).toBe('BACKUP_KEY_INVALID');
        expect((err as Error).message).toContain(String(MIN_BACKUP_KEY_LENGTH));
      }
    });

    it('refuses the documented placeholder key', () => {
      try {
        new BackupEncryptionService(
          config({ [BACKUP_ENCRYPTION_KEY_ENV]: PLACEHOLDER_BACKUP_KEYS[0] }),
        );
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as BackupEncryptionError).code).toBe('BACKUP_KEY_INVALID');
      }
    });

    it('refuses a predecessor key equal to, or shorter than, the active key', () => {
      expect(
        () =>
          new BackupEncryptionService(
            config({
              [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY,
              [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: ACTIVE_KEY,
            }),
          ),
      ).toThrow(BackupEncryptionError);

      expect(
        () =>
          new BackupEncryptionService(
            config({
              [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY,
              [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: 'too-short',
            }),
          ),
      ).toThrow(BackupEncryptionError);
    });

    it('never puts key material in a refusal message', () => {
      try {
        new BackupEncryptionService(
          config({
            [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY,
            [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: ACTIVE_KEY,
          }),
        );
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as Error).message).not.toContain(ACTIVE_KEY);
      }
    });
  });

  describe('encrypt / decrypt', () => {
    let service: BackupEncryptionService;

    beforeEach(() => {
      service = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY }),
      );
    });

    it('round-trips plaintext under the active key', () => {
      expect(service.decrypt(service.encrypt(PLAINTEXT))).toBe(PLAINTEXT);
    });

    it('writes a versioned, self-describing envelope', () => {
      const envelope = service.encrypt(PLAINTEXT);
      const [version, keyId, iv, tag, ciphertext] = envelope.split(':');

      expect(version).toBe(BACKUP_ENVELOPE_VERSION);
      expect(keyId).toMatch(/^[0-9a-f]{12}$/);
      expect(iv).toMatch(/^[0-9a-f]{24}$/);
      expect(tag).toMatch(/^[0-9a-f]{32}$/);
      expect(ciphertext).toMatch(/^[0-9a-f]+$/);
      expect(Buffer.from(ciphertext, 'hex').toString('utf8')).not.toContain(
        'backup',
      );
    });

    it('uses a fresh IV per encryption', () => {
      const first = service.encrypt(PLAINTEXT);
      const second = service.encrypt(PLAINTEXT);

      expect(first).not.toBe(second);
      expect(service.decrypt(first)).toBe(service.decrypt(second));
    });

    it('fails closed on tampered ciphertext and tags', () => {
      const envelope = service.encrypt(PLAINTEXT);
      const parts = envelope.split(':');
      const tamperedCiphertext = [...parts];
      tamperedCiphertext[4] = parts[4].replace(/^../, '00');
      const tamperedTag = [...parts];
      tamperedTag[3] = parts[3].replace(/^../, '00');

      for (const candidate of [
        tamperedCiphertext.join(':'),
        tamperedTag.join(':'),
      ]) {
        try {
          service.decrypt(candidate);
          throw new Error('expected a refusal');
        } catch (err) {
          expect((err as BackupEncryptionError).code).toBe(
            'BACKUP_DECRYPT_FAILED',
          );
        }
      }
    });

    it('refuses malformed or unknown-version envelopes', () => {
      for (const candidate of ['', 'nope', 'v2:abcdef123456:00:00:00']) {
        try {
          service.decrypt(candidate);
          throw new Error('expected a refusal');
        } catch (err) {
          expect((err as BackupEncryptionError).code).toBe(
            'BACKUP_KEY_VERSION_UNSUPPORTED',
          );
        }
      }
    });
  });

  describe('key rotation', () => {
    it('decrypts artifacts written under the predecessor key', () => {
      const before = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY }),
      );
      const envelope = before.encrypt(PLAINTEXT);

      const during = new BackupEncryptionService(
        config({
          [BACKUP_ENCRYPTION_KEY_ENV]: NEW_KEY,
          [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: ACTIVE_KEY,
        }),
      );

      expect(during.snapshot().rotationInFlight).toBe(true);
      expect(during.decrypt(envelope)).toBe(PLAINTEXT);
    });

    it('refuses an envelope from a key that has been retired', () => {
      const before = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY }),
      );
      const envelope = before.encrypt(PLAINTEXT);

      const after = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: NEW_KEY }),
      );

      try {
        after.decrypt(envelope);
        throw new Error('expected a refusal');
      } catch (err) {
        expect((err as BackupEncryptionError).code).toBe(
          'BACKUP_KEY_VERSION_UNSUPPORTED',
        );
      }
    });

    it('re-encrypts an artifact under the active key', () => {
      const before = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY }),
      );
      const envelope = before.encrypt(PLAINTEXT);

      const during = new BackupEncryptionService(
        config({
          [BACKUP_ENCRYPTION_KEY_ENV]: NEW_KEY,
          [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: ACTIVE_KEY,
        }),
      );
      const rotated = during.reencrypt(envelope);

      // The rotated envelope is bound to the new key only: once the
      // predecessor is dropped from the secret manager it still opens.
      const after = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: NEW_KEY }),
      );
      expect(rotated.split(':')[1]).not.toBe(envelope.split(':')[1]);
      expect(after.decrypt(rotated)).toBe(PLAINTEXT);
    });

    it('reports a passing rotation probe in steady state and mid-rotation', () => {
      const steady = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY }),
      );
      expect(steady.rotationProbe()).toMatchObject({
        activeKeyWorks: true,
        previousKeyWorks: true,
        previousKeyConfigured: false,
      });

      const midRotation = new BackupEncryptionService(
        config({
          [BACKUP_ENCRYPTION_KEY_ENV]: NEW_KEY,
          [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: ACTIVE_KEY,
        }),
      );
      expect(midRotation.rotationProbe()).toMatchObject({
        activeKeyWorks: true,
        previousKeyWorks: true,
        previousKeyConfigured: true,
      });
    });
  });

  it('exposes only hashes and booleans in its ops-safe snapshot', () => {
    const service = new BackupEncryptionService(
      config({
        [BACKUP_ENCRYPTION_KEY_ENV]: ACTIVE_KEY,
        [BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV]: PREVIOUS_KEY,
      }),
    );
    const snapshot = service.snapshot();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.activeKeyId).toMatch(/^[0-9a-f]{12}$/);
    expect(snapshot.previousKeyId).toMatch(/^[0-9a-f]{12}$/);
    expect(serialized).not.toContain(ACTIVE_KEY);
    expect(serialized).not.toContain(PREVIOUS_KEY);
  });
});
