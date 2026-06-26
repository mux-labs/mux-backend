import { Logger } from '@nestjs/common';
import { RequestContext } from '../common/context/request-context';

export function logWebhookOperation(
  logger: Logger,
  level: 'log' | 'warn' | 'error',
  message: string,
  meta: Record<string, unknown> = {},
): void {
  logger[level](
    JSON.stringify({
      message,
      requestId: RequestContext.getRequestId(),
      ...meta,
    }),
  );
}
