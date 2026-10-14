import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  BACKUP_ENCRYPTION_KEY_ENV,
  BackupEncryptionService,
} from './backup-encryption.service';
import { BackupActor, BackupErrorCode, BackupService } from './backup.service';
import type { BackupStore } from './backup.store';

const BACKUP_KEY = 'unit-test-backup-key-0123456789abcdef-32chars';
const CORRELATION_ID = 'corr-backup-1';

const cron: BackupActor = {
  subjectId: 'cron-secret',
  role: 'cron',
  correlationId: CORRELATION_ID,
};

function codeOf(err: unknown): string {
  const exception = err as { getResponse?: () => unknown };
  const response =
    typeof exception.getResponse === 'function'
      ? exception.getResponse()
      : undefined;
  return (response as { code?: string } | undefined)?.code ?? 'NO_CODE';
}

/** HTTP status carried by a Nest exception, or 0 when there is none. */
function statusOf(err: unknown): number {
  const exception = err as { getStatus?: () => number };
  return typeof exception.getStatus === 'function' ? exception.getStatus() : 0;
}

function config(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

describe('BackupService', () => {
  let store: BackupStore;
  let ping: jest.Mock;
  let countRecords: jest.Mock;
  let schema: jest.Mock;
  let metrics: { incrementCounter: jest.Mock };
  let encryption: BackupEncryptionService;
  let service: BackupService;

  beforeEach(() => {
    ping = jest.fn().mockResolvedValue(undefined);
    countRecords = jest.fn().mockResolvedValue({
      users: 100,
      wallets: 250,
      transactions: 1500,
      apiKeys: 50,
      projects: 10,
      developers: 5,
    });
    schema = jest.fn().mockResolvedValue({
      tables: [
        'users',
        'wallets',
        'transactions',
        'api_keys',
        'projects',
        'developers',
      ],
      foreignKeys: 12,
      indexes: 24,
    });
    store = { ping, countRecords, schema };
    metrics = { incrementCounter: jest.fn() };
    encryption = new BackupEncryptionService(
      config({ [BACKUP_ENCRYPTION_KEY_ENV]: BACKUP_KEY }),
    );
    service = new BackupService(
      store,
      encryption,
      metrics as unknown as MetricsService,
    );
  });

  describe('deny-by-default authz', () => {
    it('rejects a request with no principal', async () => {
      const err = await service
        .healthCheck({ ...cron, subjectId: '' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect(codeOf(err)).toBe(BackupErrorCode.UNAUTHORIZED);
      expect(ping).not.toHaveBeenCalled();
    });

    it('rejects an unsupported role', () => {
      try {
        service.getBackupProcedures({ ...cron, role: 'service' });
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(codeOf(err)).toBe(BackupErrorCode.FORBIDDEN);
      }
    });

    it('accepts the documented principals', async () => {
      for (const role of ['owner', 'guardian', 'api-key', 'jwt', 'cron']) {
        await expect(
          service.healthCheck({ ...cron, role }),
        ).resolves.toMatchObject({ databaseHealthy: true });
      }
    });
  });

  describe('health check', () => {
    it('reports a healthy database with a correlation id', async () => {
      const health = await service.healthCheck(cron);

      expect(health).toMatchObject({
        databaseHealthy: true,
        connectionWorks: true,
        query: 'success',
        correlationId: CORRELATION_ID,
      });
    });

    it('reports an unreachable database instead of throwing', async () => {
      ping.mockRejectedValueOnce(new Error('connection refused'));

      const health = await service.healthCheck(cron);

      expect(health.databaseHealthy).toBe(false);
      expect(health.query).toBe('failed');
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'backup_health_failed_total',
      );
    });
  });

  describe('metadata and drills', () => {
    it('collects backup metadata', async () => {
      const metadata = await service.collectBackupMetadata({ actor: cron });

      expect(metadata.status).toBe('success');
      expect(metadata.recordCounts).toMatchObject({ users: 100, wallets: 250 });
      expect(metadata.correlationId).toBe(CORRELATION_ID);
    });

    it('replays a duplicate idempotency key without re-running', async () => {
      const first = await service.collectBackupMetadata({
        actor: cron,
        idempotencyKey: 'backup-2026-01-01',
      });
      const second = await service.collectBackupMetadata({
        actor: cron,
        idempotencyKey: 'backup-2026-01-01',
      });

      expect(second.backupId).toBe(first.backupId);
      expect(countRecords).toHaveBeenCalledTimes(1);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'backup_idempotency_hit_total',
      );
    });

    it('rejects a malformed idempotency key', async () => {
      const err = await service
        .collectBackupMetadata({ actor: cron, idempotencyKey: 'bad key!' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(BackupErrorCode.INVALID_INPUT);
      expect(countRecords).not.toHaveBeenCalled();
    });

    it('passes a restore drill when the schema is intact', async () => {
      const drill = await service.performRestoreDrill({ actor: cron });

      expect(drill.success).toBe(true);
      expect(drill.validationResults).toEqual({
        tablesExist: true,
        recordsCountMatch: true,
        constraintsIntact: true,
        indexesPresent: true,
      });
    });

    it('fails the drill when a required table is missing', async () => {
      schema.mockResolvedValueOnce({
        tables: ['users'],
        foreignKeys: 0,
        indexes: 0,
      });

      const drill = await service.performRestoreDrill({ actor: cron });

      expect(drill.success).toBe(false);
      expect(drill.validationResults.tablesExist).toBe(false);
      expect(drill.validationResults.constraintsIntact).toBe(false);
    });

    it('fails closed when the database is unavailable', async () => {
      countRecords.mockRejectedValueOnce(new Error('db down'));

      const err = await service
        .collectBackupMetadata({ actor: cron })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(codeOf(err)).toBe(BackupErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(statusOf(err)).toBe(503);
    });
  });

  describe('restore intent', () => {
    it('accepts a well-formed request and normalizes the target', async () => {
      const receipt = await service.restore({
        actor: cron,
        backupId: 'backup_1704067200000_abc',
        targetEnvironment: 'testnet',
      });

      expect(receipt).toMatchObject({
        status: 'accepted',
        targetEnvironment: 'TESTNET',
        replayed: false,
        correlationId: CORRELATION_ID,
      });
    });

    it('rejects a malformed backup id', async () => {
      const err = await service
        .restore({
          actor: cron,
          backupId: 'bad id with spaces',
          targetEnvironment: 'testnet',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(codeOf(err)).toBe(BackupErrorCode.INVALID_INPUT);
    });

    it('rejects an unknown target environment', async () => {
      const err = await service
        .restore({
          actor: cron,
          backupId: 'backup_1',
          targetEnvironment: 'staging',
        })
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(BackupErrorCode.INVALID_INPUT);
    });

    it('conflicts when a key is reused with a different payload', async () => {
      await service.restore({
        actor: cron,
        idempotencyKey: 'restore-1',
        backupId: 'backup_a',
        targetEnvironment: 'testnet',
      });

      const err = await service
        .restore({
          actor: cron,
          idempotencyKey: 'restore-1',
          backupId: 'backup_b',
          targetEnvironment: 'testnet',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err)).toBe(BackupErrorCode.IDEMPOTENCY_CONFLICT);
      expect(statusOf(err)).toBe(409);
    });

    it('replays an identical restore request', async () => {
      const payload = {
        actor: cron,
        idempotencyKey: 'restore-2',
        backupId: 'backup_a',
        targetEnvironment: 'mainnet',
      };
      const first = await service.restore(payload);
      const second = await service.restore(payload);

      expect(second.replayed).toBe(true);
      expect(second.backupId).toBe(first.backupId);
    });
  });

  describe('backup encryption key rotation (#947)', () => {
    it('returns a passing probe and the ops-safe keyring snapshot', async () => {
      const result = await service.rotateEncryptionKey({
        actor: cron,
        idempotencyKey: 'rotate-1',
      });

      expect(result.probe).toMatchObject({
        activeKeyWorks: true,
        previousKeyWorks: true,
        previousKeyConfigured: false,
      });
      expect(result.keyring.rotationInFlight).toBe(false);
      expect(result.keyring.activeKeyId).toMatch(/^[0-9a-f]{12}$/);
      // No key material in the response.
      expect(JSON.stringify(result)).not.toContain(BACKUP_KEY);
    });

    it('is safe to replay', async () => {
      const first = await service.rotateEncryptionKey({
        actor: cron,
        idempotencyKey: 'rotate-2',
      });
      const second = await service.rotateEncryptionKey({
        actor: cron,
        idempotencyKey: 'rotate-2',
      });

      expect(second.probe.activeKeyId).toBe(first.probe.activeKeyId);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'backup_idempotency_hit_total',
      );
    });

    it('fails closed when the rotation probe fails', async () => {
      const broken = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: BACKUP_KEY }),
      );
      jest.spyOn(broken, 'rotationProbe').mockImplementation(() => {
        throw new Error('canary decrypt failed');
      });
      const failing = new BackupService(
        store,
        broken,
        metrics as unknown as MetricsService,
      );

      const err = await failing
        .rotateEncryptionKey({ actor: cron })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(codeOf(err)).toBe(BackupErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'backup_key_rotation_failed_total',
      );
    });

    it('refuses the rotation when a predecessor artifact no longer decrypts', async () => {
      const broken = new BackupEncryptionService(
        config({ [BACKUP_ENCRYPTION_KEY_ENV]: BACKUP_KEY }),
      );
      jest.spyOn(broken, 'rotationProbe').mockReturnValue({
        activeKeyWorks: true,
        previousKeyWorks: false,
        previousKeyConfigured: true,
        activeKeyId: 'deadbeef0000',
        previousKeyId: 'deadbeef0001',
      });
      const failing = new BackupService(
        store,
        broken,
        metrics as unknown as MetricsService,
      );

      const err = await failing
        .rotateEncryptionKey({ actor: cron })
        .catch((e: unknown) => e);

      expect(codeOf(err)).toBe(BackupErrorCode.DEPENDENCY_UNAVAILABLE);
    });
  });

  it('never includes key material in responses', async () => {
    const health = await service.healthCheck(cron);
    const metadata = await service.collectBackupMetadata({ actor: cron });
    const drill = await service.performRestoreDrill({ actor: cron });
    const rotation = await service.rotateEncryptionKey({ actor: cron });

    const serialized = JSON.stringify({ health, metadata, drill, rotation });
    expect(serialized).not.toContain(BACKUP_KEY);
    expect(serialized).not.toMatch(/privateKey|encryptedSecret|jwt/i);
  });
});
