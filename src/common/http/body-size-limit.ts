import { HttpStatus } from '@nestjs/common';
import {
  ErrorRequestHandler,
  Request,
  RequestHandler,
  Response,
  json,
  urlencoded,
} from 'express';

type MiddlewareApplication = {
  use(...handlers: Array<RequestHandler | ErrorRequestHandler>): unknown;
};

/**
 * Installs the request body parsers with an explicit byte limit.
 *
 * Nest's implicit parser must be disabled when the application is created so
 * this is the only parser that consumes the request stream.
 */
export function configureBodySizeLimit(
  app: MiddlewareApplication,
  limitBytes: number,
): void {
  app.use(
    json({ limit: limitBytes }) as RequestHandler,
    urlencoded({ extended: true, limit: limitBytes }) as RequestHandler,
    payloadTooLargeHandler,
  );
}

const payloadTooLargeHandler: ErrorRequestHandler = (
  error: Error & { type?: string; status?: number },
  _request: Request,
  response: Response,
  next,
) => {
  if (
    error.type !== 'entity.too.large' &&
    error.status !== HttpStatus.PAYLOAD_TOO_LARGE
  ) {
    next(error);
    return;
  }

  response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    error: 'Payload Too Large',
    message: 'Request body exceeds the maximum allowed size',
  });
};
