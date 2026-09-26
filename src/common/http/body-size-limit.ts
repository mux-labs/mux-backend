import { NestExpressApplication } from '@nestjs/platform-express';

/**
 * Configures the JSON body size limit for the Express application.
 * Oversized payloads are rejected with a 413 error.
 */
export function configureBodySizeLimit(
  app: NestExpressApplication,
  limitBytes: number = 1024 * 1024, // Default 1MB
): void {
  const limit = `${limitBytes}b`;
  
  // Apply to JSON body parser
  app.use((req, res, next) => {
    // Check content-length header
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const length = parseInt(contentLength, 10);
      if (length > limitBytes) {
        return res.status(413).json({
          statusCode: 413,
          error: 'Payload Too Large',
          message: `Request body exceeds maximum size of ${limitBytes} bytes`,
          errorCode: 'PAYLOAD_TOO_LARGE',
          requestId: req.headers['x-request-id'] || 'unknown',
        });
      }
    }
    next();
  });
}