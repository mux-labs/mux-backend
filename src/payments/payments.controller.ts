import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { resolveRequestId } from '../common/interceptors/request-id.interceptor';
import { PaymentMoneyPathDto } from './dto/payment-money-path.dto';
import type {
  PaymentActor,
  PaymentExecutionResult,
  PaymentIntent,
} from './payment-money-path.model';
import { PaymentMoneyPathService } from './payment-money-path.service';

/**
 * REST surface for the payment money path.
 *
 * Every route is a write-adjacent surface, so it is deny-by-default: the
 * actor is resolved from the request context the auth guard populated
 * (`paymentActor`, then `apiKeyContext`, then `apiKey`) — never from the body,
 * query string, or headers, none of which a caller can be trusted to assert.
 * If no server-resolved principal exists, `PaymentMoneyPathService` rejects
 * the request with 401 before any dependency is touched.
 *
 * `POST /v1/payments` is the documented payment entrypoint
 * (`docs/PAYMENT-DRY-RUN.md`): pass `dry_run` in the body or `X-Dry-Run: true`
 * to run the same policy without ever submitting to Horizon (#945).
 */
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentMoneyPathService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() body: PaymentMoneyPathDto,
    @Req() req: Request,
    @Headers('x-dry-run') dryRunHeader?: string,
    @Headers('idempotency-key') idempotencyKeyHeader?: string,
    @Headers('x-request-id') requestIdHeader?: string,
  ): Promise<PaymentExecutionResult> {
    const intent: PaymentIntent = {
      walletId: body?.walletId,
      receiverWalletId: body?.receiverWalletId,
      amount: body?.amount,
      assetCode: body?.assetCode,
      network: body?.network,
      // Either spelling requests a dry-run; there is no way to turn one off
      // via a header once the body asks for it.
      dryRun: body?.dryRun === true || isTruthyHeader(dryRunHeader),
      idempotencyKey: body?.idempotencyKey ?? idempotencyKeyHeader,
    };

    return this.payments.execute(intent, this.actor(req, requestIdHeader));
  }

  /**
   * GET /v1/payments/policy
   *
   * The effective money-path flags (booleans and env var *names* only) so an
   * operator can confirm what is actually in force. Never returns flag values,
   * secrets, or key material.
   */
  @Get('policy')
  policy(): Record<string, string | boolean> {
    return this.payments.describe();
  }

  /**
   * Resolve the server-attested principal.
   *
   * Only properties set by a guard are consulted, in order of specificity.
   * Client-controlled input (body, query, headers) is never read here, so a
   * caller cannot assert a role, a subject, or an elevated identity.
   */
  private actor(req: Request, correlationIdHeader?: string): PaymentActor {
    const correlationId = resolveRequestId(correlationIdHeader);
    const scoped = req as Request & {
      paymentActor?: PaymentActor;
      apiKeyContext?: { id?: string; developerId?: string };
      apiKey?: { apiKey?: { id?: string } };
    };

    if (scoped.paymentActor?.subjectId) {
      return { ...scoped.paymentActor, correlationId };
    }

    const apiKeyContextId =
      scoped.apiKeyContext?.developerId ??
      scoped.apiKeyContext?.id ??
      scoped.apiKey?.apiKey?.id;
    if (apiKeyContextId) {
      return { subjectId: apiKeyContextId, role: 'api-key', correlationId };
    }

    // No principal: hand an empty subject to the service, which rejects it
    // with 401 (deny-by-default) before anything else runs.
    return { subjectId: '', role: 'api-key', correlationId };
  }
}

/** Accept only an explicit truthy header value (fail-closed on garbage). */
function isTruthyHeader(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
