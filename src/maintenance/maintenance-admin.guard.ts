import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  MAINTENANCE_SECRET_RESULT,
  MAINTENANCE_UNAUTHORIZED_ERROR_CODE,
  MaintenanceSecretService,
} from './maintenance-secret.service';

/**
 * Authorizes `PATCH /v1/maintenance` (#925).
 *
 * This guard is the *only* consumer of the maintenance admin secret, which is
 * what makes the rotation window meaningful: the previous secret is honoured
 * here, and only here, while its overlap window is open.
 *
 * Invariants:
 *
 * 1. **Deny-by-default.** No configured secret authorizes nobody. There is no
 *    bypass, no development fallback, and no environment that relaxes this.
 * 2. **Rotation-aware.** Verification is delegated to
 *    {@link MaintenanceSecretService}, so comparison is constant time over
 *    SHA-256 digests and the previous secret is accepted only inside its
 *    window.
 * 3. **Non-revealing.** Every refusal is the same `401` +
 *    `MAINTENANCE_UNAUTHORIZED`. The specific reason (`MISSING`, `MISMATCH`,
 *    `PREVIOUS_EXPIRED`, `NOT_CONFIGURED`) goes to the log only, so the
 *    response cannot be used to probe which part of a guess was right.
 * 4. **No secret in the log.** Only the stable reason code and the correlation
 *    id are written — never the presented or configured value.
 * 5. **An unfinished rotation is alertable.** A caller authorized by the
 *    *previous* secret is logged at `warn`, so an operator can see that
 *    machines are still holding the old value before the window closes.
 */
@Injectable()
export class MaintenanceAdminGuard implements CanActivate {
  private readonly logger = new Logger(MaintenanceAdminGuard.name);

  constructor(private readonly secrets: MaintenanceSecretService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { requestId?: string }>();

    const outcome = this.secrets.verify(request);
    const correlationId = request?.requestId ?? 'unknown';

    if (outcome.authorized) {
      if (outcome.usedPreviousSecret) {
        // Not an error, but it means the rotation is not finished: some caller
        // is still on the previous secret.
        this.logger.warn(
          `maintenance admin authorized with PREVIOUS secret (rotation in progress) requestId=${correlationId}`,
        );
      }
      return true;
    }

    if (outcome.result === MAINTENANCE_SECRET_RESULT.MISMATCH) {
      this.logger.warn(
        `maintenance admin rejected: reason=${outcome.result} requestId=${correlationId}`,
      );
    } else {
      this.logger.error(
        `maintenance admin rejected: reason=${outcome.result} requestId=${correlationId}`,
      );
    }

    throw new UnauthorizedException({
      errorCode: MAINTENANCE_UNAUTHORIZED_ERROR_CODE,
      message: 'A valid maintenance administrator secret is required',
    });
  }
}
