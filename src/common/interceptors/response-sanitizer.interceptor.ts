import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Fields that must never be returned in API responses.
 * Applied globally so no controller can accidentally leak secrets.
 */
const SENSITIVE_KEYS = new Set([
  'privateKey',
  'encryptedSecret',
  'encrypted_secret',
  'webhookSecret',
  'whsec',
  'apiKey',
  'secret',
  'token',
  'password',
]);

/**
 * Global interceptor that strips sensitive fields from all
 * API responses. This is a defense-in-depth measure: even if
 * a controller accidentally returns a secret, the interceptor
 * redacts it before it reaches the client.
 */
@Injectable()
export class ResponseSanitizerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => this.sanitize(data)),
    );
  }

  private sanitize(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item));
    }

    if (typeof value === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (SENSITIVE_KEYS.has(key)) {
          sanitized[key] = '[REDACTED]';
        } else {
          sanitized[key] = this.sanitize(val);
        }
      }
      return sanitized;
    }

    return value;
  }
}
