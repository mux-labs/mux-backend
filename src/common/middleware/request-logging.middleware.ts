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
 * #787 — Headers that must NEVER appear in info logs.
 *
 * Any header in this set is replaced with the literal string "[REDACTED]"
 * before being written to any log line.  The check is case-insensitive so
 * "Authorization", "authorization", and "AUTHORIZATION" are all matched.
 *
 * Extend this set with care — every entry here is a security invariant.
 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'x-internal-api-key',
  'x-maintenance-secret',
  'x-recovery-admin-secret',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

/**
 * Returns a sanitized copy of the provided headers object where every
 * sensitive header value has been replaced with "[REDACTED]".
 *
 * Only call this when you need to log header information.  The original
 * request object is never mutated.
 */
export function redactSensitiveHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string | string[] | undefined> {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  const safe: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    safe[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return safe;
}

/**
 * Returns true when the header name is sensitive and must be redacted.
 * Exposed for unit testing.
 */
export function isSensitiveHeader(headerName: string): boolean {
  return SENSITIVE_HEADERS.has(headerName.toLowerCase());
}

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

    // #787: Never log Authorization, X-API-Key, or any other sensitive header.
    // The URL and method are safe to log; individual header values are NOT
    // logged at all in the request-start line — only the redacted-safe copy is
    // used when we need to surface header context for debugging.
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
