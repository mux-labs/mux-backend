import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { MetricsService } from '../metrics/metrics.service';
import { ErrorCode } from '../dto/error-envelope.dto';
import { GracefulShutdownService } from './graceful-shutdown.service';

/** Methods that never mutate state and stay served during a drain. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Fail-closed write gate for graceful shutdown (#950).
 *
 * While {@link GracefulShutdownService.isDraining} is true, any mutating
 * request (`POST`/`PUT`/`PATCH`/`DELETE`) is rejected immediately with `503
 * SHUTDOWN_IN_PROGRESS` and a `Retry-After` header, so a client cannot start a
 * new payment/wallet write on a process that is about to exit. Reads and
 * health/readiness probes keep working so a load balancer can observe the drain
 * and stop routing traffic.
 *
 * Ordering note: a request that entered the pipeline *before* the signal is
 * already inside its tracked operation and is unaffected; only requests that
 * arrive after `markDraining()` are refused.
 */
@Injectable()
export class DrainInProgressInterceptor implements NestInterceptor {
  constructor(
    private readonly shutdown: GracefulShutdownService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<{ method?: string }>();
    const method = (request?.method ?? 'GET').toUpperCase();

    if (SAFE_METHODS.has(method) || !this.shutdown.isDraining()) {
      return next.handle();
    }

    this.metrics?.incrementCounter('shutdown_write_rejected');
    throw new ServiceUnavailableException({
      errorCode: ErrorCode.SHUTDOWN_IN_PROGRESS,
      message:
        'The service is shutting down and is not accepting new writes; retry shortly.',
      retryAfterSeconds: 1,
    });
  }
}
