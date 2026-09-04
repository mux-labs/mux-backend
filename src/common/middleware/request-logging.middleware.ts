import { Request, Response, NextFunction } from 'express';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RequestContextService } from '../request-context/request-context.service';

// Client-reported app version, e.g. "2.4.1" or "ios-2.4.1". Kept
// intentionally permissive (covers semver plus common platform prefixes)
// while still rejecting anything long enough or shaped enough to be log
// injection / control characters rather than a genuine version string.
const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/**
 * Reads and validates the optional `X-Client-Version` header used to tag
 * support logs with the reporting client's app version. Returns undefined
 * (never throws) when the header is absent, empty, or doesn't look like a
 * safe version string — callers should treat a missing client version as a
 * non-fatal, expected case.
 */
export function extractClientVersion(req: Request | any): string | undefined {
  if (!req || !req.headers) {
    return undefined;
  }

  const raw = req.headers['x-client-version'] ?? req.headers['X-Client-Version'];
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || !CLIENT_VERSION_PATTERN.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

export function requestLogger(
  req: Request | any,
  res: Response | any,
  next: NextFunction,
) {
  const logger = new Logger('RequestLogger');

  if (!req) {
    logger.warn('Request logging skipped: invalid request object');
    next();
    return;
  }

  let clientVersion: string | undefined;
  let id: string;

  try {
    const idHeader =
      req.headers &&
      (req.headers['x-request-id'] || req.headers['X-Request-Id']);
    id =
      typeof idHeader === 'string' && idHeader.length > 0
        ? idHeader
        : randomUUID();
    const start = Date.now();

    req.requestId = id;

    // Optional client app version, e.g. "2.4.1". Never fatal to the request
    // — a missing or malformed header simply means downstream support logs
    // won't be tagged with a client version.
    clientVersion = extractClientVersion(req);
    req.clientVersion = clientVersion;

    if (res && typeof res.setHeader === 'function') {
      try {
        res.setHeader('x-request-id', id);
      } catch (e) {
        /* best-effort */
      }
    }

    const ip =
      (req.ip || (req.socket && req.socket.remoteAddress)) || 'unknown';
    const method = req.method || 'UNKNOWN';
    const url = (req.originalUrl || req.url) || 'unknown';
    const clientVersionSuffix = clientVersion
      ? ` clientVersion=${clientVersion}`
      : '';

    logger.log(`${method} ${url} id=${id} ip=${ip}${clientVersionSuffix}`);

    if (res && typeof res.on === 'function') {
      res.on('finish', () => {
        const ms = Date.now() - start;
        try {
          logger.log(
            `Completed ${res.statusCode || 0} in ${ms}ms id=${id}${clientVersionSuffix}`,
          );
        } catch (e) {
          logger.warn(
            'Failed to log response finish: ' + (e && (e as Error).message),
          );
        }
      });
    }

    RequestContextService.run({ requestId: id, clientVersion }, () => {
      try {
        next();
      } catch (e) {
        logger.warn('next() threw in requestLogger');
      }
    });
  } catch (err: any) {
    logger.warn('Request logging failed: ' + (err && err.message));
    try {
      // Propagate the request ID (and client version, when present) through
      // AsyncLocalStorage so downstream code (controllers, services — e.g.
      // auth/session flows) can access it via RequestContextService without
      // needing direct access to the Express request object.
      if (id) {
        RequestContextService.run({ requestId: id, clientVersion }, () =>
          next(),
        );
      } else {
        next();
      }
    } catch (e) {
      logger.warn('next() threw after requestLogger error');
    }
  }
}

export default requestLogger;
