import { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import { REQUEST_ID_HEADER, getRequestId } from '../http/correlation';

/** Express request carrying the correlation id assigned by this middleware. */
type RequestWithId = Request & { requestId?: string };

/**
 * Request logging middleware that:
 * - Resolves a correlation id **once** and shares it with every downstream
 *   layer (error envelope, guards, outbound webhooks) via `req.requestId` and
 *   the `X-Request-ID` header (#927)
 * - Logs incoming requests with the correlation id
 * - Measures request duration
 *
 * The inbound `X-Request-ID` is honoured only when it is short and log-safe;
 * otherwise a UUID is generated, so a client cannot forge a log line or a
 * metric label. Log lines carry the id and request metadata only — never a
 * header value, body, or credential.
 */
export class RequestLoggingMiddleware {
  private readonly logger = new Logger('RequestLogger');

  use(req: Request, res: Response, next: NextFunction): void {
    const startTime = Date.now();

    // Resolve or generate the correlation id, then re-stamp the inbound header
    // so interceptors, guards, and the exception filter all read the same one.
    const requestId = getRequestId(req as never);
    req.headers[REQUEST_ID_HEADER] = requestId;
    (req as RequestWithId).requestId = requestId;

    // Echo the id back so a client can quote it in a support request.
    res.setHeader(REQUEST_ID_HEADER, requestId);

    this.logger.log(
      `${req.method} ${req.originalUrl} - Request ID: ${requestId}`,
    );

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
export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const middleware = new RequestLoggingMiddleware();
  middleware.use(req, res, next);
};

export default requestLogger;
