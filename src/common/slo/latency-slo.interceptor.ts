import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LatencySloService } from './latency-slo.service';

/**
 * NestJS interceptor that records HTTP request latency and feeds it into
 * the LatencySloService for SLO compliance tracking.
 *
 * Register globally in app.module or per-controller:
 *
 *   providers: [
 *     { provide: APP_INTERCEPTOR, useClass: LatencySloInterceptor },
 *   ]
 */
@Injectable()
export class LatencySloInterceptor implements NestInterceptor {
  constructor(
    @Optional() private readonly sloService?: LatencySloService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (!this.sloService) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<{
      method: string;
      url: string;
      path?: string;
      route?: { path: string };
    }>();

    const startMs = Date.now();
    // Use the route template (e.g. /wallets/:id) when available to avoid
    // high-cardinality label explosion in metrics backends.
    const routeTemplate: string =
      request.route?.path ?? request.path ?? request.url ?? '/';
    const method: string = request.method ?? 'GET';

    return next.handle().pipe(
      tap({
        next: () => this.record(routeTemplate, method, startMs),
        error: () => this.record(routeTemplate, method, startMs),
      }),
    );
  }

  private record(route: string, method: string, startMs: number): void {
    const durationMs = Date.now() - startMs;
    this.sloService!.record({
      route,
      method,
      durationMs,
      timestamp: new Date(),
    });
  }
}
