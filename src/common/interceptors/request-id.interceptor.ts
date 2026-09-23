import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';

/**
 * Header used to propagate a correlation id across services and logs.
 * Clients may supply their own value; otherwise the server generates one.
 */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Maximum accepted length for a client-supplied correlation id. Longer values
 * are rejected and replaced with a server-generated id to avoid log injection
 * and unbounded header amplification on privileged surfaces (e.g. tx export).
 */
export const MAX_REQUEST_ID_LENGTH = 128;

/**
 * Correlation ids must be opaque and safe to embed in logs, metrics labels,
 * and error payloads. We only accept a conservative character set so that
 * adversarial input cannot spoof structured log fields or inject control chars.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Attaches a correlation id to every request so that privileged entrypoints
 * (transaction export jobs, wallet/payment APIs) can emit stable, traceable
 * error codes without leaking secrets. The id is echoed back on the response
 * and exposed on the request for downstream handlers and loggers.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      headers?: Record<string, unknown>;
      requestId?: string;
    }>();
    const response = http.getResponse<{ setHeader?: (name: string, value: string) => void }>();

    const requestId = this.resolveRequestId(request?.headers);

    if (request) {
      request.requestId = requestId;
    }

    if (response && typeof response.setHeader === 'function') {
      response.setHeader(REQUEST_ID_HEADER, requestId);
    }

    return next.handle();
  }

  /**
   * Fail-closed resolution: only well-formed, bounded client ids are trusted;
   * anything else is replaced with a freshly generated UUID.
   */
  private resolveRequestId(headers?: Record<string, unknown>): string {
    const raw = headers?.[REQUEST_ID_HEADER] ?? headers?.[REQUEST_ID_HEADER.toUpperCase()];
    const candidate = Array.isArray(raw) ? raw[0] : raw;

    if (typeof candidate !== 'string') {
      return randomUUID();
    }

    const trimmed = candidate.trim();

    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_REQUEST_ID_LENGTH ||
      !REQUEST_ID_PATTERN.test(trimmed)
    ) {
      return randomUUID();
    }

    return trimmed;
  }
}
