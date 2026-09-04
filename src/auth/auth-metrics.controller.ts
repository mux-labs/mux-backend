import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthMetricsService, AuthMetricsSnapshot } from './auth-metrics.service';

/**
 * Exposes read-only auth metrics.
 *
 * Route: GET /auth/metrics
 *
 * This endpoint requires a valid API key (inherits the global ApiKeyGuard).
 * It is intentionally NOT marked @Public() so that raw metric data is not
 * accessible without authentication.
 */
@Controller('auth')
export class AuthMetricsController {
  constructor(private readonly authMetrics: AuthMetricsService) {}

  /**
   * Returns a point-in-time snapshot of auth instrumentation counters.
   *
   * Response shape mirrors {@link AuthMetricsSnapshot}.
   */
  @Get('metrics')
  @HttpCode(HttpStatus.OK)
  getMetrics(): AuthMetricsSnapshot {
    return this.authMetrics.getSnapshot();
  }
}
