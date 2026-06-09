import { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

export function requestLogger(
  req: Request | any,
  res: Response | any,
  next: NextFunction,
) {
  const logger = new Logger('RequestLogger');
  try {
    if (!req) {
      logger.warn('Request logging skipped: invalid request object');
      next();
      return;
    }

    const idHeader =
      req &&
      req.headers &&
      (req.headers['x-request-id'] || req.headers['X-Request-Id']);
    const id =
      typeof idHeader === 'string' && idHeader.length > 0
        ? idHeader
        : randomUUID();
    const start = Date.now();

    if (res && typeof res.setHeader === 'function') {
      try {
        res.setHeader('x-request-id', id);
      } catch (e) {
        /* best-effort */
      }
    }

    const ip =
      (req && (req.ip || (req.socket && req.socket.remoteAddress))) ||
      'unknown';
    const method = (req && req.method) || 'UNKNOWN';
    const url = (req && (req.originalUrl || req.url)) || 'unknown';

    logger.log(`${method} ${url} id=${id} ip=${ip}`);

    if (res && typeof res.on === 'function') {
      res.on('finish', () => {
        const ms = Date.now() - start;
        try {
          logger.log(`Completed ${res.statusCode || 0} in ${ms}ms id=${id}`);
        } catch (e) {
          logger.warn(
            'Failed to log response finish: ' + (e && (e as Error).message),
          );
        }
      });
    }
  } catch (err: any) {
    logger.warn('Request logging failed: ' + (err && err.message));
  } finally {
    try {
      next();
    } catch (e) {
      logger.warn('next() threw in requestLogger');
    }
  }
}

export default requestLogger;
