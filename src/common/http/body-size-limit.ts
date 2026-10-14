import { Request, Response, NextFunction } from 'express';

/**
 * Maximum request body size in bytes.
 * Requests exceeding this limit are rejected with 413 Payload Too Large
 * before they reach any controller logic.
 */
export const MAX_BODY_SIZE = 1024 * 1024; // 1 MiB

/**
 * Middleware that enforces a maximum request body size.
 * Reads content-length and rejects oversized requests early.
 */
export function configureBodySizeLimit(): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const size = parseInt(contentLength as string, 10);
      if (size > MAX_BODY_SIZE) {
        res.status(413).json({
          message: 'Request body too large',
          errorCode: 'PAYLOAD_TOO_LARGE',
          maxSize: MAX_BODY_SIZE,
        });
        return;
      }
    }
    next();
  };
}
