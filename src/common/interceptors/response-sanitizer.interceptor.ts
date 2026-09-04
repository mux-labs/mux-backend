import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

const SENSITIVE_FIELDS = new Set([
  'privateKey',
  'private_key',
  'encryptedSecret',
  'encrypted_secret',
]);

/**
 * Recursively redacts sensitive fields from a response object so that
 * private key material and other secrets never reach the HTTP response body.
 *
 * Applied at the controller level (or globally) as an interceptor.
 */
function sanitizeResponseBody(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 10) return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponseBody(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SENSITIVE_FIELDS.has(key)) {
        // Redact the field – replace string values with '[REDACTED]'
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeResponseBody(val, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * Interceptor that strips sensitive fields (privateKey, encryptedSecret, etc.)
 * from all HTTP responses.
 *
 * Usage (controller-scoped):
 *   @UseInterceptors(ResponseSanitizerInterceptor)
 *
 * Or register globally in AppModule:
 *   providers: [{ provide: APP_INTERCEPTOR, useClass: ResponseSanitizerInterceptor }]
 */
@Injectable()
export class ResponseSanitizerInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseSanitizerInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((responseBody) => {
        if (responseBody === null || responseBody === undefined) {
          return responseBody;
        }
        return sanitizeResponseBody(responseBody);
      }),
    );
  }
}
