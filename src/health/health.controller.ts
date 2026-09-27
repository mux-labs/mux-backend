import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../api-keys/api-key.decorator';

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness probe - returns 200 if the process is alive.
   * Does not check database connectivity.
   */
  @Get('health')
  @Public()
  @HttpCode(HttpStatus.OK)
  async health() {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      build: process.env.BUILD_VERSION || 'development',
    };
  }

  /**
   * Readiness probe - returns 200 if database is connected, 503 otherwise.
   */
  @Get('ready')
  @Public()
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ready',
        timestamp: new Date().toISOString(),
        database: {
          connected: true,
          responseTime: 0,
        },
      };
    } catch (error) {
      return {
        status: 'not ready',
        timestamp: new Date().toISOString(),
        database: {
          connected: false,
          error: error.message,
        },
      };
    }
  }

  /**
   * Maintenance status endpoint.
   */
  @Get('maintenance')
  @Public()
  async maintenance() {
    try {
      const state = await this.prisma.maintenanceState.findUnique({
        where: { id: 'global' },
      });
      return {
        enabled: state?.enabled ?? false,
        message: state?.message ?? null,
        retryAfterSeconds: state?.retryAfterSeconds ?? null,
      };
    } catch (error) {
      return { enabled: false };
    }
  }
}