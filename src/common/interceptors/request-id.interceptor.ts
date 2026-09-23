import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/**
 * Header used to correlate a request with its logs and error envelope.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Property attached to the request object so downstream handlers,
 * filters and loggers can read the correlation id.
 */
export const REQUEST_ID_PROPERTY = 'requestId';

/**
 * Maximum accepted length for an inbound request id. Anything longer is
 * treated as adversarial input and replaced with a freshly generated id.
 */
const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Only allow opaque, log-safe identifiers. Rejecting control characters and
 * whitespace prevents header/log injection through a spoofed request id.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;

/**
 * Resolves a trustworthy request id: reuse a well-formed inbound value when
 * present, otherwise generate a new one. Never trust arbitrary client input.
 */
export function resolveRequestId(inbound?: unknown): string {
  if (
    typeof inbound === 'string' &&
    inbound.length > 0 &&
    inbound.length <= MAX_REQUEST_ID_LENGTH &&
    SAFE_REQUEST_ID.test(inbound)
  ) {
    return inbound;
  }
  return randomUUID();
}

/**
 * Assigns a correlation id to every request, echoes it back on the response
 * and exposes it on the request so the error envelope and logs can include it.
 *
 * Internal cron-triggered endpoints are guarded by a required cron secret
 * (see CronSecretGuard). Auth failures on those routes are surfaced with a
 * stable error code and the correlation id below, without ever echoing the
 * secret material back to the caller.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const requestId = resolveRequestId(
      request?.headers?.[REQUEST_ID_HEADER] ?? request?.headers?.[REQUEST_ID_HEADER.toUpperCase()],
    );

    if (request) {
      request[REQUEST_ID_PROPERTY] = requestId;
    }

    if (response && typeof response.setHeader === 'function') {
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }

    return next.handle().pipe(
      tap({
        error: () => {
          // The id is already attached to the request; the exception filter
          // reads it from there when building the sanitized error envelope.
        },
      }),
    );
  }
}
