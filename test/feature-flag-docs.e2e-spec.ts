import * as fs from 'fs';
import * as path from 'path';
import {
  LEGACY_MAINNET_ENABLED_ENVS,
  PAYMENT_DRY_RUN_ENABLED_ENV,
  PAYMENT_KILL_SWITCH_ENV,
  PAYMENT_MAINNET_ENABLED_ENV,
} from '../src/payments/payment-money-path.policy';
import {
  BACKUP_ENCRYPTION_KEY_ENV,
  BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV,
  MIN_BACKUP_KEY_LENGTH,
  PLACEHOLDER_BACKUP_KEYS,
} from '../src/backup/backup-encryption.service';

/**
 * Documentation <-> code contract for the money-path flags (#945, #946) and the
 * backup encryption key rotation (#947).
 *
 * Pure documentation test: no DB, no network, no secrets. It fails when an
 * operator-facing variable, runbook statement, or code constant drifts apart,
 * because a misconfigured mainnet flag or a missing backup key is a money-path
 * incident, not a documentation nit.
 */
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('money-path and backup flag documentation contract', () => {
  const envExample = read('.env.example');
  const mainnetDoc = read('docs/MAINNET-PAYMENT-FEATURE-FLAG.md');
  const dryRunDoc = read('docs/PAYMENT-DRY-RUN.md');
  const backupDoc = read('docs/BACKUP_RESTORE_PROCEDURES.md');

  describe('.env.example', () => {
    it.each([
      PAYMENT_MAINNET_ENABLED_ENV,
      PAYMENT_DRY_RUN_ENABLED_ENV,
      PAYMENT_KILL_SWITCH_ENV,
    ])('documents %s as deny-by-default', (envName) => {
      expect(envExample).toContain(`${envName}=false`);
    });

    it('documents the legacy mainnet alias so a rename cannot surprise operators', () => {
      expect(LEGACY_MAINNET_ENABLED_ENVS.length).toBeGreaterThan(0);
      expect(mainnetDoc).toContain(LEGACY_MAINNET_ENABLED_ENVS[0]);
      expect(envExample).toContain(LEGACY_MAINNET_ENABLED_ENVS[0]);
    });

    it('documents the backup encryption key and its predecessor', () => {
      expect(envExample).toContain(`${BACKUP_ENCRYPTION_KEY_ENV}=`);
      expect(envExample).toContain(`${BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV}=`);
      // The documented placeholder is the one the service rejects at boot.
      expect(envExample).toContain(PLACEHOLDER_BACKUP_KEYS[0]);
      expect(backupDoc).toContain(String(MIN_BACKUP_KEY_LENGTH));
    });
  });

  describe('docs/MAINNET-PAYMENT-FEATURE-FLAG.md', () => {
    it('documents every canonical money-path flag', () => {
      for (const envName of [
        PAYMENT_MAINNET_ENABLED_ENV,
        PAYMENT_DRY_RUN_ENABLED_ENV,
        PAYMENT_KILL_SWITCH_ENV,
      ]) {
        expect(mainnetDoc).toContain(envName);
      }
    });

    it('states the error codes the service actually emits', () => {
      for (const code of [
        'PAYMENT_MAINNET_DISABLED',
        'PAYMENT_DRY_RUN_DISABLED',
        'PAYMENT_KILL_SWITCH_ENGAGED',
        'PAYMENT_MAINNET_MISCONFIGURED',
      ]) {
        expect(mainnetDoc).toContain(code);
      }
    });

    it('points at the enforcement point and its tests', () => {
      expect(mainnetDoc).toContain(
        'src/payments/payment-money-path.service.ts',
      );
      expect(mainnetDoc).toContain(
        'src/payments/payment-money-path.service.spec.ts',
      );
    });
  });

  describe('docs/PAYMENT-DRY-RUN.md', () => {
    it('uses the canonical dry-run error code', () => {
      expect(dryRunDoc).toContain('PAYMENT_DRY_RUN_DISABLED');
    });

    it('states that a dry-run never submits and never calls Horizon', () => {
      expect(dryRunDoc).toMatch(/never submits to Stellar\/Horizon/);
      expect(dryRunDoc).toContain('src/payments/payment-money-path.service.ts');
    });
  });

  describe('docs/BACKUP_RESTORE_PROCEDURES.md', () => {
    it('documents the rotation procedure and its probe endpoint', () => {
      expect(backupDoc).toContain('Backup Encryption Key Rotation');
      expect(backupDoc).toContain('POST /backup/encryption/rotate-key');
      expect(backupDoc).toContain(BACKUP_ENCRYPTION_KEY_ENV);
      expect(backupDoc).toContain(BACKUP_ENCRYPTION_KEY_PREVIOUS_ENV);
    });

    it('has no dangling file references', () => {
      for (const reference of backupDoc.matchAll(/\]\(([^)]+)\)/g)) {
        const target = reference[1];
        if (target.startsWith('http') || target.startsWith('#')) {
          continue;
        }
        const resolved = path.join(
          __dirname,
          '..',
          path.dirname('docs/BACKUP_RESTORE_PROCEDURES.md'),
          target.split('#')[0],
        );
        expect(fs.existsSync(resolved)).toBe(true);
      }
    });

    it('no longer points at code that does not exist', () => {
      expect(backupDoc).not.toContain('src/app.service.ts');
      expect(backupDoc).not.toContain('key-management-consolidation.md');
    });
  });
});
