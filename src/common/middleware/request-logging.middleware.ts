import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { REQUEST_ID_HEADER, getRequestId } from '../http/correlation';

/**
 * Middleware that ensures every request has a correlation id
 * in the x-request-id header. If the client supplies one,
 * it is validated and passed through; otherwise a server-generated
 * id is set.
 *
 * The correlation id is also attached to the request object so
 * downstream handlers can access it without re-reading headers.
 *
 * The id is resolved once through the shared `getRequestId()` helper
 * (#927) rather than by re-implementing the length/character rules
 * here. That keeps the accept/reject decision identical to the one the
 * exception filter and the outbound webhook dispatcher use, so a single
 * client-supplied header can never yield a different id in the access log
 * than in the error envelope. `getRequestId()` re-validates the value, so a
 * hostile header still cannot inject control characters into a log line.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('RequestLogging');

  use(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    const requestId = getRequestId(req as never);

    // Attach to request for downstream use, and re-stamp the inbound header so
    // interceptors, guards, and the exception filter all read the same id.
    (req as Request & { requestId?: string }).requestId = requestId;
    req.headers[REQUEST_ID_HEADER] = requestId;

    // Set response header so the client can correlate
    res.setHeader(REQUEST_ID_HEADER, requestId);

    this.logger.debug(`${req.method} ${req.url} requestId=${requestId}`);

    // Log completion with the same correlation id, so a slow or failed
    // request is visible in the access log. Metadata only — never a header
    // value, body, or credential.
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      this.logger.debug(
        `${req.method} ${req.url} ${res.statusCode} ${durationMs}ms requestId=${requestId}`,
      );
    });

    next();
  }
}

// Export a function that creates the middleware instance
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const middleware = new RequestLoggingMiddleware();
  middleware.use(req, res, next);
};

export default requestLogger;
