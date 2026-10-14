import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CronSecretGuard } from '../common/cron/cron-secret.guard';
import { resolveRequestId } from '../common/interceptors/request-id.interceptor';
import { RestoreBackupDto } from './dto/restore-backup.dto';
import { BackupActor, BackupService } from './backup.service';

/**
 * Admin endpoints for backup and restore operations.
 *
 * Every route is behind {@link CronSecretGuard}: without a valid
 * `X-Cron-Secret` the request is refused with 401 before the controller runs
 * (deny-by-default, constant-time comparison, no implicit allow path). The
 * service then re-checks the principal's role, so the endpoint stays guarded
 * even if it is later mounted behind a different guard.
 *
 * Contract: `docs/BACKUP_RESTORE_PROCEDURES.md` §9. Responses carry
 * correlation ids and counts only — no credentials, no key material.
 */
@Controller('backup')
@UseGuards(CronSecretGuard)
export class BackupController {
  constructor(private readonly backup: BackupService) {}

  /** GET /v1/backup/health */
  @Get('health')
  health(@Req() req: Request, @Headers('x-request-id') requestId?: string) {
    return this.backup.healthCheck(this.actor(req, requestId));
  }

  /** POST /v1/backup/metadata — idempotent when `Idempotency-Key` is sent. */
  @Post('metadata')
  @HttpCode(HttpStatus.OK)
  collectMetadata(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.backup.collectBackupMetadata({
      actor: this.actor(req, requestId),
      idempotencyKey,
    });
  }

  /** POST /v1/backup/drill — non-destructive restore drill. */
  @Post('drill')
  @HttpCode(HttpStatus.OK)
  restoreDrill(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.backup.performRestoreDrill({
      actor: this.actor(req, requestId),
      idempotencyKey,
    });
  }

  /** GET /v1/backup/procedures */
  @Get('procedures')
  procedures(@Req() req: Request, @Headers('x-request-id') requestId?: string) {
    return this.backup.getBackupProcedures(this.actor(req, requestId));
  }

  /** POST /v1/backup/restore — validates and records the intent only. */
  @Post('restore')
  @HttpCode(HttpStatus.ACCEPTED)
  restore(
    @Body() body: RestoreBackupDto,
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.backup.restore({
      actor: this.actor(req, requestId),
      idempotencyKey,
      backupId: body?.backupId,
      targetEnvironment: body?.targetEnvironment ?? 'testnet',
    });
  }

  /** POST /v1/backup/encryption/rotate-key — rotation canary probe. */
  @Post('encryption/rotate-key')
  @HttpCode(HttpStatus.OK)
  rotateEncryptionKey(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.backup.rotateEncryptionKey({
      actor: this.actor(req, requestId),
      idempotencyKey,
    });
  }

  /**
   * Build the server-resolved principal.
   *
   * `CronSecretGuard` has already authenticated the shared secret, so the
   * role is the guard's own credential — never a client-supplied field.
   */
  private actor(_req: Request, correlationId?: string): BackupActor {
    return {
      subjectId: 'cron-secret',
      role: 'cron',
      correlationId: resolveRequestId(correlationId),
    };
  }
}
