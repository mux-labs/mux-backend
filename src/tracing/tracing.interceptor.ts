import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { TracingService } from './tracing.service';

/**
 * Optional interceptor that instruments HTTP requests with OpenTelemetry spans.
 * Can be registered globally in app.module to enable automatic tracing of all requests.
 *
 * Usage:
 *   providers: [
 *     {
 *       provide: APP_INTERCEPTOR,
 *       useClass: TracingInterceptor,
 *     },
 *   ]
 */
@Injectable()
export class TracingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TracingInterceptor.name);

  constructor(private readonly tracingService: TracingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const tracer = this.tracingService.getTracer();
    const request = context.switchToHttp().getRequest();
    const { method, url } = request;

    const spanName = `${method} ${url}`;

    // If tracer is no-op, just pass through without tracing
    if (!this.tracingService.isReady()) {
      return next.handle();
    }

    return tracer.startActiveSpan(spanName, (span: any) => {
      return next.handle().pipe(
        tap((res) => {
          const response = context.switchToHttp().getResponse();
          if (span) {
            span.setAttribute('http.status_code', response.statusCode);
            span.setAttribute('http.method', method);
            span.setAttribute('http.url', url);
          }
          return res;
        }),
        catchError((err) => {
          if (span) {
            span.setAttribute('error', true);
            span.setAttribute('error.message', err.message);
            span.addEvent('exception', { error: err });
          }
          throw err;
        }),
      );
    });
  }
}
