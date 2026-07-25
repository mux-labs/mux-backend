import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { Request } from 'express';

/**
 * Patterns for field names that indicate sensitive data should be redacted.
 */
const SENSITIVE_FIELD_PATTERNS = [
  /^private[_-]?key$/i,
  /^encrypted[_-]?secret$/i,
  /^secret$/i,
  /^secret_key$/i,
  /^secretKey$/i,
  /^api[_-]?key$/i,
  /^apiKey$/i,
  /^token$/i,
  /^access[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^authorization$/i,
  /^password$/i,
];

const REDACTED = '[REDACTED]';

/**
 * Determines if a field name matches any sensitive pattern.
 */
function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively redacts sensitive fields from a value, returning a new safe copy.
 * Strings that look like long hex or base64 blobs (>40 chars) are also redacted.
 */
function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 10) return value;

  // Redact long hex/base64 strings (private keys, signatures, etc.)
  if (typeof value === 'string') {
    if (value.length > 64) {
      return REDACTED;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveField(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * ResponseRedactionInterceptor
 *
 * Automatically redacts sensitive fields (private keys, secrets, tokens, etc.)
 * from all API responses before they are serialized and sent to the client.
 *
 * This provides a defense-in-depth layer on top of individual service-level
 * redaction, ensuring no secrets leak even if a new endpoint forgets to strip
 * sensitive fields.
 *
 * The interceptor excludes the `/health` and `/metrics` endpoints from redaction
 * since those paths never contain sensitive data and redaction would add
 * unnecessary overhead there.
 */
@Injectable()
export class ResponseRedactionInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseRedactionInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();

    // Skip redaction for health/metrics endpoints for performance
    if (request.path?.startsWith('/health') || request.path?.startsWith('/metrics')) {
      return next.handle();
    }

    return next.handle().pipe(
      map((responseBody) => {
        if (responseBody === null || responseBody === undefined) {
          return responseBody;
        }
        try {
          return redact(responseBody);
        } catch (error) {
          this.logger.warn(
            `Response redaction failed for ${request.method} ${request.url}: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Never throw from redaction — return the original response body
          // so the API stays available even if redaction logic has a bug.
          return responseBody;
        }
      }),
    );
  }
}

// Export redact for unit testing
export { redact, isSensitiveField };
