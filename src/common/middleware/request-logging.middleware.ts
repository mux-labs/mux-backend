import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { REQUEST_ID_HEADER, resolveRequestId } from '../interceptors';

/**
 * Request logging middleware that:
 * - Generates/propagates X-Request-ID header
 * - Logs incoming requests with correlation IDs
 * - Measures request duration
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('RequestLogger');

  use(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    // Resolve or generate request ID
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    req.headers[REQUEST_ID_HEADER] = requestId;
    (req as any).requestId = requestId;

    // Set response header
    res.setHeader(REQUEST_ID_HEADER, requestId);

    // Log request
    this.logger.log(
      `${req.method} ${req.originalUrl} - Request ID: ${requestId}`,
    );

    // Log response when finished
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      this.logger.log(
        `${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms - Request ID: ${requestId}`,
      );
    });

    next();
  }
}

// Export a function that creates the middleware instance
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const middleware = new RequestLoggingMiddleware();
  middleware.use(req, res, next);
};

export default requestLogger;