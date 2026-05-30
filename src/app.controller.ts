import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Liveness probe endpoint for Kubernetes/container orchestration
   * Returns 200 if the application process is alive and responsive
   * Does NOT check external dependencies (use /ready for that)
   *
   * Use cases:
   * - Kubernetes liveness probes
   * - Container health checks
   * - Load balancer health monitoring
   * - Uptime monitoring
   */
  @Get('health')
  @Public()
  checkHealth(): {
    status: string;
    timestamp: string;
    uptime: number;
    version?: string;
  } {
    return this.appService.checkHealth();
  }
}
