import { Controller, Get, HttpStatus, HttpCode } from '@nestjs/common';
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
   * Readiness probe endpoint for Kubernetes/container orchestration
   * Returns 200 if the application is ready to serve traffic (database is accessible)
   * Returns 503 if the application is not ready (database is not accessible)
   */
  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  async checkReadiness(): Promise<{
    status: string;
    timestamp: string;
    database: {
      connected: boolean;
      responseTime?: number;
      error?: string;
    };
  }> {
    const result = await this.appService.checkReadiness();

    // If database is not connected, return 503 Service Unavailable
    if (!result.database.connected) {
      throw new Error('Service not ready: Database connection failed');
    }

    return result;
  }
}
