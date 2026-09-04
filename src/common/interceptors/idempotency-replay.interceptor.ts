import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Marker interface for responses that include idempotency metadata
 */
export interface IdempotentResponse {
  data: any;
  _idempotencyKey?: string;
  _isReplay?: boolean;
  _createdAt?: Date;
}

/**
 * Interceptor that adds idempotency headers to responses.
 * Looks for _idempotencyKey, _isReplay, and _createdAt in response object.
 * These are stripped from the final response body.
 *
 * Headers added:
 * - Idempotency-Key: echoes back the key
 * - Idempotency-Replay: "true" only if this is a replay
 * - Idempotency-Created-At: ISO timestamp of original creation
 */
@Injectable()
export class IdempotencyReplayInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyReplayInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((response) => {
        const httpContext = context.switchToHttp();
        const res = httpContext.getResponse();

        // Check if response has idempotency metadata
        if (
          response &&
          typeof response === 'object' &&
          '_idempotencyKey' in response
        ) {
          const idempotencyKey = (response as IdempotentResponse)._idempotencyKey;
          const isReplay = (response as IdempotentResponse)._isReplay;
          const createdAt = (response as IdempotentResponse)._createdAt;

          // Set headers
          if (idempotencyKey) {
            res.setHeader('Idempotency-Key', idempotencyKey);
          }

          if (isReplay) {
            res.setHeader('Idempotency-Replay', 'true');
          }

          if (createdAt) {
            res.setHeader(
              'Idempotency-Created-At',
              new Date(createdAt).toISOString(),
            );
          }

          // Strip metadata from response body
          const cleanedResponse = { ...response };
          delete cleanedResponse._idempotencyKey;
          delete cleanedResponse._isReplay;
          delete cleanedResponse._createdAt;

          return cleanedResponse;
        }

        return response;
      }),
    );
  }
}
