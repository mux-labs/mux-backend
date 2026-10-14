import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  BackupEncryptionService,
  RotationProbeResult,
} from './backup-encryption.service';
import {
  BACKUP_STORE,
  COUNTED_BACKUP_TABLES,
  REQUIRED_BACKUP_TABLES,
} from './backup.store';
import type {
  BackupRecordCounts,
  BackupSchemaSnapshot,
  BackupStore,
} from './backup.store';
import { Inject } from '@nestjs/common';

/** Stable, typed error codes for the backup surface (`docs/BACKUP_...`). */
export const BackupErrorCode = {
  /** Missing or invalid credential (401). */
  UNAUTHORIZED: 'BACKUP_UNAUTHORIZED',
  /** Authenticated but insufficient role (403). */
  FORBIDDEN: 'BACKUP_FORBIDDEN',
  /** RPC/DB/Horizon unavailable; the operation failed closed (503). */
  DEPENDENCY_UNAVAILABLE: 'BACKUP_DEPENDENCY_UNAVAILABLE',
  /** Same idempotency key with a different payload (409). */
  IDEMPOTENCY_CONFLICT: 'BACKUP_IDEMPOTENCY_CONFLICT',
  /** Adversarial or malformed input (400). */
  INVALID_INPUT: 'BACKUP_INVALID_INPUT',
  /** Unexpected failure (500). */
  INTERNAL_ERROR: 'BACKUP_INTERNAL_ERROR',
} as const;

export type BackupErrorCode =
  (typeof BackupErrorCode)[keyof typeof BackupErrorCode];

/**
 * Roles accepted on the backup surface. `cron` is the shared-secret path used
 * by scheduled jobs (`X-Cron-Secret`, `CronSecretGuard`); the rest are the
 * principals named in `docs/BACKUP_RESTORE_PROCEDURES.md` §9.
 */
export const BACKUP_ROLES: readonly string[] = [
  'owner',
  'guardian',
  'api-key',
  'jwt',
  'cron',
];

/** Idempotency keys accepted on the backup surface. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** How long a memoized drill result is replayed. */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/** Server-resolved principal for a backup request. */
export interface BackupActor {
  subjectId: string;
  role: string;
  correlationId: string;
}

/** Per-request options shared by the write endpoints. */
export interface BackupOperation {
  actor: BackupActor;
  idempotencyKey?: string;
}

/** Health check response (`GET /backup/health`). */
export interface BackupHealthCheck {
  databaseHealthy: boolean;
  connectionWorks: boolean;
  query: 'success' | 'failed';
  timestamp: string;
  message: string;
  correlationId: string;
}

/** Backup metadata snapshot (`POST /backup/metadata`). */
export interface BackupMetadata {
  backupId: string;
  timestamp: string;
  duration: number;
  status: 'success' | 'failed';
  recordCounts: BackupRecordCounts;
  correlationId: string;
}

/** Restore drill result (`POST /backup/drill`). */
export interface RestoreDrillResult {
  drillId: string;
  timestamp: string;
  duration: number;
  success: boolean;
  correlationId: string;
  validationResults: {
    tablesExist: boolean;
    recordsCountMatch: boolean;
    constraintsIntact: boolean;
    indexesPresent: boolean;
  };
  recordCounts: BackupRecordCounts;
}

/** Accepted restore request (`POST /backup/restore`). */
export interface BackupRestoreReceipt {
  status: 'accepted';
  backupId: string;
  targetEnvironment: 'TESTNET' | 'MAINNET';
  correlationId: string;
  replayed: boolean;
}

/**
 * BackupService — health, metadata, restore drills, procedures, and the
 * backup encryption key rotation (#947).
 *
 * Invariants (`docs/BACKUP_RESTORE_PROCEDURES.md` §8, asserted by
 * `backup.service.spec.ts`):
 *
 *  1. **Deny-by-default authz.** Every entrypoint requires an authenticated
 *     principal; unknown roles and missing subjects are refused (401/403).
 *  2. **Idempotency.** A replayed `Idempotency-Key` returns the original
 *     result without re-executing; the same key with a different payload is
 *     `BACKUP_IDEMPOTENCY_CONFLICT` (409).
 *  3. **Fail-closed.** A store failure becomes
 *     `BACKUP_DEPENDENCY_UNAVAILABLE` (503). No partial or best-effort writes.
 *  4. **Source of truth.** Backup metadata is advisory and never overrides
 *     on-chain state.
 *  5. **No secret leakage.** Logs and metrics carry correlation ids, counts,
 *     and stable error codes — never keys, JWTs, or webhook secrets.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  /** Memoized drill results, keyed by idempotency key (see §9 of the runbook). */
  private readonly memo = new Map<
    string,
    { fingerprint: string; result: unknown; expiresAt: number }
  >();

  constructor(
    @Inject(BACKUP_STORE) private readonly store: BackupStore,
    private readonly encryption: BackupEncryptionService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Health check (`GET /backup/health`).
   *
   * Read-only and deliberately non-throwing on an unhealthy database: the
   * endpoint *reports* reachability, so operators can see an outage instead of
   * getting a 503 that hides which dependency failed.
   */
  async healthCheck(actor: BackupActor): Promise<BackupHealthCheck> {
    this.assertAuthorized(actor);
    const timestamp = new Date().toISOString();
    try {
      await this.store.ping();
      this.metrics.incrementCounter('backup_health_total');
      return {
        databaseHealthy: true,
        connectionWorks: true,
        query: 'success',
        timestamp,
        message: 'Database connection is healthy',
        correlationId: actor.correlationId,
      };
    } catch (err) {
      this.metrics.incrementCounter('backup_health_failed_total');
      this.logger.error(
        `backup.health failed correlationId=${actor.correlationId} ` +
          `reason=${this.errorName(err)}`,
      );
      return {
        databaseHealthy: false,
        connectionWorks: false,
        query: 'failed',
        timestamp,
        message: 'Database connection failed',
        correlationId: actor.correlationId,
      };
    }
  }

  /** Collect backup metadata (`POST /backup/metadata`). Idempotent. */
  async collectBackupMetadata(
    operation: BackupOperation,
  ): Promise<BackupMetadata> {
    this.assertAuthorized(operation.actor);
    const correlationId = operation.actor.correlationId;

    const { result } = await this.replayable<BackupMetadata>(
      operation.idempotencyKey,
      'backup/metadata',
      async () => {
        const started = Date.now();
        const recordCounts = await this.readRecordCounts(correlationId);
        return {
          backupId: `backup_${Date.now()}_${randomUUID().slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          duration: Date.now() - started,
          status: 'success' as const,
          recordCounts,
          correlationId,
        };
      },
    );
    return result;
  }

  /**
   * Restore drill (`POST /backup/drill`) — non-destructive validation that the
   * schema and row counts are restore-ready. Idempotent.
   */
  async performRestoreDrill(
    operation: BackupOperation,
  ): Promise<RestoreDrillResult> {
    this.assertAuthorized(operation.actor);
    const correlationId = operation.actor.correlationId;

    const { result } = await this.replayable<RestoreDrillResult>(
      operation.idempotencyKey,
      'backup/drill',
      async () => {
        const started = Date.now();
        const recordCounts = await this.readRecordCounts(correlationId);
        const schema = await this.readSchema(correlationId);
        const tables = new Set(schema.tables.map((name) => name.toLowerCase()));
        const tablesExist = REQUIRED_BACKUP_TABLES.every((name) =>
          tables.has(name),
        );
        const recordsCountMatch = COUNTED_BACKUP_TABLES.every(
          (name) => recordCounts[name] >= 0,
        );
        const constraintsIntact = schema.foreignKeys > 0;
        const indexesPresent = schema.indexes > 0;
        const success =
          tablesExist &&
          recordsCountMatch &&
          constraintsIntact &&
          indexesPresent;

        this.metrics.incrementCounter(
          success ? 'backup_drill_total' : 'backup_drill_failed_total',
        );
        this.logger.log(
          `backup.drill success=${success} correlationId=${correlationId}`,
        );

        return {
          drillId: `drill_${Date.now()}_${randomUUID().slice(0, 8)}`,
          timestamp: new Date().toISOString(),
          duration: Date.now() - started,
          success,
          correlationId,
          validationResults: {
            tablesExist,
            recordsCountMatch,
            constraintsIntact,
            indexesPresent,
          },
          recordCounts,
        };
      },
    );
    return result;
  }

  /** Operational procedures returned by `GET /backup/procedures`. */
  getBackupProcedures(actor: BackupActor): {
    backup: string[];
    restore: string[];
    testing: string[];
  } {
    this.assertAuthorized(actor);
    return {
      backup: [
        '1. Verify database health using GET /backup/health',
        '2. Collect backup metadata with POST /backup/metadata (Idempotency-Key)',
        '3. Create the dump with pg_dump and store it encrypted at rest',
        '4. Keep WALLET_ENCRYPTION_KEY and BACKUP_ENCRYPTION_KEY in the secret manager only',
      ],
      restore: [
        '1. Verify the restore target exists',
        '2. Register the intent with POST /backup/restore',
        '3. Restore the dump, then re-run POST /backup/drill',
      ],
      testing: [
        '1. Schedule monthly restore drills on staging',
        '2. Run GET /backup/health before each drill',
        '3. Rotate BACKUP_ENCRYPTION_KEY with POST /backup/encryption/rotate-key',
      ],
    };
  }

  /**
   * Restore request (`POST /backup/restore`).
   *
   * Non-destructive: it validates the request and records the intent. The
   * actual data movement is an operator runbook step (`§4` of the doc), never
   * an API side effect — a client cannot make the server rewrite a database.
   */
  async restore(
    operation: BackupOperation & {
      backupId: string;
      targetEnvironment: string;
    },
  ): Promise<BackupRestoreReceipt> {
    this.assertAuthorized(operation.actor);
    const correlationId = operation.actor.correlationId;
    const backupId = this.requireIdentifier(operation.backupId, 'backupId');
    const targetEnvironment = this.requireEnvironment(
      operation.targetEnvironment,
    );

    const fingerprint = `backup/restore::${backupId}::${targetEnvironment}`;
    const { result, replayed } = await this.replayable<BackupRestoreReceipt>(
      operation.idempotencyKey,
      fingerprint,
      () => ({
        status: 'accepted' as const,
        backupId,
        targetEnvironment,
        correlationId,
        replayed: false,
      }),
    );
    this.logger.log(
      `backup.restore accepted environment=${targetEnvironment} ` +
        `replayed=${replayed} correlationId=${correlationId}`,
    );
    return { ...result, replayed };
  }

  /**
   * Backup encryption key rotation (`POST /backup/encryption/rotate-key`).
   *
   * Runs the canary probe documented in `docs/BACKUP_RESTORE_PROCEDURES.md`
   * §4.4: the active key must round-trip, and an artifact written under the
   * configured predecessor key must still decrypt. Only a passing probe means
   * the operator may drop the old key from the secret manager. The endpoint
   * performs no key change itself — key material lives in the secret manager,
   * never in the request path — so it is naturally idempotent and safe to
   * replay.
   */
  async rotateEncryptionKey(operation: BackupOperation): Promise<{
    probe: RotationProbeResult;
    keyring: ReturnType<BackupEncryptionService['snapshot']>;
  }> {
    this.assertAuthorized(operation.actor);
    const correlationId = operation.actor.correlationId;

    const { result } = await this.replayable<{
      probe: RotationProbeResult;
      keyring: ReturnType<BackupEncryptionService['snapshot']>;
    }>(operation.idempotencyKey, 'backup/encryption/rotate-key', () => {
      let probe: RotationProbeResult;
      try {
        probe = this.encryption.rotationProbe();
      } catch (err) {
        // A failed probe must refuse the rotation, loudly and fail-closed.
        this.metrics.incrementCounter('backup_key_rotation_failed_total');
        this.logger.error(
          `backup.encryption.rotation probe failed correlationId=${correlationId} ` +
            `reason=${this.errorName(err)}`,
        );
        throw new ServiceUnavailableException({
          code: BackupErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'Backup encryption rotation probe failed; rotation refused',
          correlationId,
        });
      }

      if (!probe.activeKeyWorks || !probe.previousKeyWorks) {
        this.metrics.incrementCounter('backup_key_rotation_failed_total');
        throw new ServiceUnavailableException({
          code: BackupErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'Backup encryption rotation probe failed; rotation refused',
          correlationId,
        });
      }

      this.metrics.incrementCounter('backup_key_rotation_total');
      this.logger.log(
        `backup.encryption.rotation probe ok activeKeyId=${probe.activeKeyId} ` +
          `previousKeyConfigured=${probe.previousKeyConfigured} ` +
          `correlationId=${correlationId}`,
      );
      return { probe, keyring: this.encryption.snapshot() };
    });
    return result;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Deny-by-default authz: no principal or unknown role is refused. */
  private assertAuthorized(actor: BackupActor): void {
    if (!actor || !actor.subjectId) {
      throw new UnauthorizedException({
        code: BackupErrorCode.UNAUTHORIZED,
        message: 'Authentication required',
        correlationId: actor?.correlationId ?? 'unknown',
      });
    }
    if (!BACKUP_ROLES.includes(actor.role)) {
      throw new ForbiddenException({
        code: BackupErrorCode.FORBIDDEN,
        message: 'Your role may not operate on backups',
        correlationId: actor.correlationId,
      });
    }
  }

  /**
   * Replayed-request handling for the admin write endpoints.
   *
   * A memo hit returns the original result without re-running the operation;
   * a different payload under the same key is a conflict. The memo is bounded
   * by a TTL and every operation it guards is read-only, so a miss after a
   * restart re-runs validation — never a destructive write.
   */
  private async replayable<T>(
    idempotencyKey: string | undefined,
    fingerprint: string,
    run: () => T | Promise<T>,
  ): Promise<{ result: T; replayed: boolean }> {
    const key = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (key !== '') {
      if (
        key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
        !IDEMPOTENCY_KEY_PATTERN.test(key)
      ) {
        throw new BadRequestException({
          code: BackupErrorCode.INVALID_INPUT,
          message: `Idempotency-Key must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters from [A-Za-z0-9._:-]`,
        });
      }
      const now = Date.now();
      this.pruneMemo(now);
      const existing = this.memo.get(key);
      if (existing && existing.expiresAt > now) {
        if (existing.fingerprint !== fingerprint) {
          this.metrics.incrementCounter('backup_idempotency_conflict_total');
          throw new ConflictException({
            code: BackupErrorCode.IDEMPOTENCY_CONFLICT,
            message: 'Idempotency key reused with a different payload',
          });
        }
        this.metrics.incrementCounter('backup_idempotency_hit_total');
        return { result: existing.result as T, replayed: true };
      }
      const result = await run();
      this.memo.set(key, {
        fingerprint,
        result,
        expiresAt: now + IDEMPOTENCY_TTL_MS,
      });
      return { result, replayed: false };
    }
    return { result: await run(), replayed: false };
  }

  /** Drop memo entries whose TTL has elapsed. TTL is the only expiry rule. */
  private pruneMemo(now: number): void {
    for (const [key, entry] of this.memo) {
      if (entry.expiresAt <= now) {
        this.memo.delete(key);
      }
    }
  }

  /** Read row counts, fail-closed on any store failure. */
  private async readRecordCounts(
    correlationId: string,
  ): Promise<BackupRecordCounts> {
    try {
      return await this.store.countRecords();
    } catch (err) {
      return this.failClosed('record counts', err, correlationId);
    }
  }

  /** Read the schema snapshot, fail-closed on any store failure. */
  private async readSchema(
    correlationId: string,
  ): Promise<BackupSchemaSnapshot> {
    try {
      return await this.store.schema();
    } catch (err) {
      return this.failClosed('schema snapshot', err, correlationId);
    }
  }

  /** Bounded, charset-restricted identifier check (log-injection guard). */
  private requireIdentifier(value: unknown, field: string): string {
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      value.length > 64 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw new BadRequestException({
        code: BackupErrorCode.INVALID_INPUT,
        message: `${field} must be 1-64 alphanumeric/._:- characters`,
      });
    }
    return value.trim();
  }

  /** Restore targets are a closed set; anything else is rejected. */
  private requireEnvironment(value: unknown): 'TESTNET' | 'MAINNET' {
    const normalized =
      typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (normalized !== 'TESTNET' && normalized !== 'MAINNET') {
      throw new BadRequestException({
        code: BackupErrorCode.INVALID_INPUT,
        message: 'targetEnvironment must be TESTNET or MAINNET',
      });
    }
    return normalized;
  }

  /** Fail-closed exit for any dependency failure. */
  private failClosed<T>(
    dependency: string,
    err: unknown,
    correlationId: string,
  ): T {
    this.metrics.incrementCounter('backup_failclosed_total');
    this.logger.error(
      `backup fail-closed dependency=${dependency} ` +
        `correlationId=${correlationId} reason=${this.errorName(err)}`,
    );
    throw new ServiceUnavailableException({
      code: BackupErrorCode.DEPENDENCY_UNAVAILABLE,
      message: `${dependency} unavailable; operation failed closed`,
      correlationId,
    });
  }

  /** Class name only — an error message could carry upstream detail. */
  private errorName(err: unknown): string {
    return err instanceof Error ? err.constructor.name : 'unknown';
  }
}
