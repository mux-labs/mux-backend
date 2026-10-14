import { Module } from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsController } from './payments.controller';
import { PAYMENT_IDEMPOTENCY_STORE } from './payment-money-path.model';
import { PaymentMoneyPathService } from './payment-money-path.service';
import { PrismaPaymentIdempotencyStore } from './prisma-payment-idempotency.store';

/**
 * Payments module: the entrypoint documented in `docs/PAYMENT-DRY-RUN.md`.
 *
 * `PAYMENT_SUBMISSION_PORT` is intentionally **not** bound here. It belongs to
 * the custody/Horizon layer that holds the wallet keys and the submission
 * endpoint; until a deployment binds it, `PaymentMoneyPathService` fails to
 * construct and the surface is unreachable — fail-closed by absence, rather
 * than a stub that would report a "successful" payment that never reached the
 * chain. Do not add a default implementation here.
 *
 * The idempotency store *is* ours (the `IdempotencyRecord` table), so it is
 * wired to {@link PrismaPaymentIdempotencyStore}.
 */
@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentMoneyPathService,
    MetricsService,
    PrismaService,
    PrismaPaymentIdempotencyStore,
    {
      provide: PAYMENT_IDEMPOTENCY_STORE,
      useExisting: PrismaPaymentIdempotencyStore,
    },
  ],
  exports: [PaymentMoneyPathService],
})
export class PaymentsModule {}
