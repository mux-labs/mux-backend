import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { REQUEST_ID_HEADER, MAX_REQUEST_ID_LENGTH } from '../interceptors/request-id.interceptor';

/**
 * Middleware that ensures every request has a correlation id
 * in the x-request-id header. If the client supplies one,
 * it is validated and passed through; otherwise a server-generated
 * id is set.
 *
 * The correlation id is also attached to the request object so
 * downstream handlers can access it without re-reading headers.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('RequestLogging');

  use(req: Request, res: Response, next: NextFunction): void {
    const incomingId = req.headers[REQUEST_ID_HEADER] as string | undefined;
    const requestId = this.normalizeRequestId(incomingId);

    // Attach to request for downstream use
    (req as any).requestId = requestId;

    // Set response header so the client can correlate
    res.setHeader(REQUEST_ID_HEADER, requestId);

    this.logger.debug(`${req.method} ${req.url} requestId=${requestId}`);

    next();
  }

  private normalizeRequestId(incoming: string | undefined): string {
    if (!incoming) {
      return this.generateRequestId();
    }

    if (incoming.length > MAX_REQUEST_ID_LENGTH) {
      return this.generateRequestId();
    }

    // Only allow safe characters to prevent log injection
    const pattern = /^[A-Za-z0-9._:-]+$/;
    if (!pattern.test(incoming)) {
      return this.generateRequestId();
    }

    return incoming;
  }

  private generateRequestId(): string {
    return crypto.randomUUID();
  }
}
