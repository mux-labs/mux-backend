import { Global, Module } from '@nestjs/common';
import { GracefulShutdownService } from './graceful-shutdown.service';
import { DrainInProgressInterceptor } from './drain-in-progress.interceptor';
import { MetricsService } from '../metrics/metrics.service';

/**
 * Graceful-shutdown drain for money-path writes (#950).
 *
 * Global so every feature module can inject {@link GracefulShutdownService} and
 * track in-flight operations without re-importing this module. The
 * {@link DrainInProgressInterceptor} is registered globally in `main.ts` after
 * the app is created (it needs the bootstrapped instance).
 */
@Global()
@Module({
  providers: [
    GracefulShutdownService,
    DrainInProgressInterceptor,
    MetricsService,
  ],
  exports: [GracefulShutdownService, DrainInProgressInterceptor],
})
export class GracefulShutdownModule {}
