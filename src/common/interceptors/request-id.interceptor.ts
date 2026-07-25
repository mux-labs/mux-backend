import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { RequestContextService } from '../request-context/request-context.service';

/**
 * RequestIdInterceptor
 *
 * Ensures every HTTP request has a unique `x-request-id` header value and
 * propagates it through the application via `RequestContextService` (AsyncLocalStorage).
 *
 * Behaviour:
 * 1. Reads `x-request-id` from the incoming request headers if present.
 * 2. If absent, generates a new UUID.
 * 3. Sets `x-request-id` on the outgoing response headers.
 * 4. Stores the request ID in `RequestContextService` so downstream services
 *    (loggers, audit trails, outbound HTTP calls) can access it without
 *    needing the Express request object.
 *
 * This interceptor is registered globally in `AppModule` and runs before
 * controller- or method-scoped interceptors.
 */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestIdInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();

    // Resolve request ID from header or generate a new one
    const headerValue =
      request.headers['x-request-id'] ||
      request.headers['X-Request-Id'];

    const requestId: string =
      typeof headerValue === 'string' && headerValue.length > 0
        ? headerValue
        : randomUUID();

    // Store on the request object for legacy middleware and logging access
    (request as any).requestId = requestId;

    // Set the response header
    response.setHeader('x-request-id', requestId);

    // Propagate into the AsyncLocalStorage context for this request's lifecycle.
    // We use enterWith (not run) because the context must persist across
    // the asynchronous Observable pipeline.  The middleware layer also calls
    // run(), so the context is already active in most cases; this call
    // ensures it's set even if the interceptor runs first or middleware
    // hasn't yet bootstrapped it.
    RequestContextService.bootstrapRequestId(requestId);

    return next.handle().pipe(
      tap({
        next: () => {
          // Ensure the header is always set even if previously missed
          if (!response.getHeader('x-request-id')) {
            response.setHeader('x-request-id', requestId);
          }
        },
        error: () => {
          // On error, still ensure the ID is on the response
          if (!response.getHeader('x-request-id')) {
            response.setHeader('x-request-id', requestId);
          }
        },
      }),
    );
  }
}
