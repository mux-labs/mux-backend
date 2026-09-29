import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService, type ReadinessResult } from './app.service';
import { Public } from './auth/public.decorator';

@ApiTags('public')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  root(): string {
    return this.appService.getHello();
  }

  /**
   * Compatibility alias for the readiness probe (#933).
   *
   * `/v1/health/ready` is the primary readiness endpoint; this path is kept so
   * an existing probe configuration does not start returning `404`. It
   * performs the same database check and **fails closed**: a database outage
   * produces `503`, never a `200`, so a pod that cannot serve traffic is
   * drained from the load balancer rather than sent live requests.
   */
  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Readiness probe (compatibility alias of GET /health/ready — fails closed)',
  })
  async checkReadiness(): Promise<ReadinessResult> {
    const result = await this.appService.checkReadiness();

    if (!result.database.connected) {
      throw new ServiceUnavailableException({
        status: 'error',
        message: 'Service not ready: database connection failed',
        database: result.database,
      });
    }

    return result;
  }
}
