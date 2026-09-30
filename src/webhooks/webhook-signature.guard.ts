import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { WebhookSignerService } from './webhook-signer.service';

export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/**
 * WebhookSignatureGuard
 *
 * Verifies the HMAC-SHA256 signature of an inbound webhook request against
 * a shared secret, using the same `t=<ts>,v1=<sig>` header format produced
 * by {@link WebhookSignerService.formatSignatureHeader}.
 *
 * This guard DOES NOT authenticate callers by identity — it only proves the
 * request body was signed by a holder of the configured secret and was not
 * tampered with in transit (and is not a stale replay).
 *
 * All rejections use the same response shape so callers get a consistent,
 * predictable error contract regardless of *why* verification failed
 * (missing header, malformed header, wrong secret, tampered body, expired
 * timestamp):
 *
 *   { statusCode: 401, message: 'Invalid webhook signature', error: 'Unauthorized' }
 *
 * Usage:
 *   @UseGuards(WebhookSignatureGuard)
 *   @Post('inbound')
 *   async receive(@Body() body: unknown) { ... }
 *
 * The signing secret is read from the `WEBHOOK_INBOUND_SECRET` environment
 * variable. If it is not configured, the guard fails closed (500) rather
 * than silently accepting unsigned requests.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSignatureGuard.name);

  constructor(
    private readonly webhookSigner: WebhookSignerService,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    const secret = this.configService.get<string>('WEBHOOK_INBOUND_SECRET');
    if (!secret) {
      this.logger.error(
        'WEBHOOK_INBOUND_SECRET is not configured; refusing to verify inbound webhook',
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Webhook verification is not configured',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const header = request.headers?.[WEBHOOK_SIGNATURE_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;

    if (!headerValue) {
      this.logger.warn('Rejected webhook: missing signature header');
      throw this.unauthorized();
    }

    const parsed = this.webhookSigner.parseSignatureHeader(headerValue);
    if (!parsed || Number.isNaN(parsed.timestamp)) {
      this.logger.warn('Rejected webhook: malformed signature header');
      throw this.unauthorized();
    }

    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    const payload = rawBody
      ? rawBody.toString('utf8')
      : JSON.stringify(request.body ?? {});

    const isValid = this.webhookSigner.verifySignature(
      payload,
      parsed.signature,
      secret,
      parsed.timestamp,
    );

    if (!isValid) {
      this.logger.warn('Rejected webhook: invalid or expired signature');
      throw this.unauthorized();
    }

    return true;
  }

  private unauthorized(): HttpException {
    return new HttpException(
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid webhook signature',
        error: 'Unauthorized',
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
