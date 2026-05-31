import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Check application readiness by pinging the database
   * @returns Object with status and database connectivity information
   */
  async checkReadiness(): Promise<{
    status: string;
    timestamp: string;
    database: {
      connected: boolean;
      responseTime?: number;
      error?: string;
    };
  }> {
    const timestamp = new Date().toISOString();
    const startTime = Date.now();

    try {
      // Perform a simple database query to verify connectivity
      // Using $queryRaw with a simple SELECT 1 query
      await this.prisma.$queryRaw`SELECT 1`;
      const responseTime = Date.now() - startTime;

      this.logger.log(`Database ping successful (${responseTime}ms)`);

      return {
        status: 'ready',
        timestamp,
        database: {
          connected: true,
          responseTime,
        },
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(
        `Database ping failed (${responseTime}ms): ${errorMessage}`,
      );

      return {
        status: 'not_ready',
        timestamp,
        database: {
          connected: false,
          responseTime,
          error: errorMessage,
        },
      };
    }
  }
}
