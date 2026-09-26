import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs/operators';
import { Observable } from 'rxjs';

/**
 * Transforms all Date values in the response body to ISO 8601 UTC strings.
 * This ensures consistent timestamp formatting across all API responses.
 */
@Injectable()
export class IsoUtcTimestampInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => this.transformDates(data)));
  }

  private transformDates(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (obj instanceof Date) {
      return obj.toISOString();
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.transformDates(item));
    }

    if (typeof obj === 'object') {
      const transformed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        transformed[key] = this.transformDates(value);
      }
      return transformed;
    }

    return obj;
  }
}