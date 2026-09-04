import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Recursively walks a plain JS value and converts every `Date` instance to
 * an ISO 8601 UTC string (e.g. `"2026-07-30T02:58:20.651Z"`).
 *
 * This ensures that all timestamps serialized in HTTP responses have a
 * consistent, timezone-unambiguous format regardless of the locale or
 * runtime environment of the server.
 *
 * Depth is capped at 20 to protect against pathological circular structures
 * (Prisma models are not circular, but defensive programming is cheap here).
 */
function serializeDates(value: unknown, depth = 0): unknown {
  if (depth > 20 || value === null || value === undefined) return value;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeDates(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = serializeDates(val, depth + 1);
    }
    return result;
  }

  return value;
}

/**
 * Global interceptor that normalizes all `Date` objects in HTTP response
 * bodies to ISO 8601 UTC strings.
 *
 * Register globally in AppModule:
 * ```ts
 * providers: [{ provide: APP_INTERCEPTOR, useClass: IsoUtcTimestampInterceptor }]
 * ```
 *
 * Or at the controller / handler level:
 * ```ts
 * \@UseInterceptors(IsoUtcTimestampInterceptor)
 * ```
 */
@Injectable()
export class IsoUtcTimestampInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((responseBody) => {
        if (responseBody === null || responseBody === undefined) {
          return responseBody;
        }
        return serializeDates(responseBody);
      }),
    );
  }
}
